#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    CONFIG,
    LOGS,
    MEGABRAIN,
    ROOT,
    SURFACES,
    alive,
    descendsFrom,
    fill,
    isolationEnv,
    listeners,
    psql,
    psqlScript,
    readRegistry,
    resolveEnv,
    surfaceMode,
    trySh,
    worktreeDatabase,
    writeRegistry,
} from './lib/env.mjs';

const FIXTURES = path.join(MEGABRAIN, 'fixtures');
const BOOTABLE = Object.fromEntries(Object.entries(SURFACES).filter(([, s]) => !s.external));

// -------------------------------------------------------------------- infra

function ensureInfra() {
    const infra = CONFIG.infra;
    if (!infra?.containers?.length) return { started: false, missing: [] };
    const running = (trySh('docker', ['ps', '--format', '{{.Names}}']) || '').split('\n');
    const missing = infra.containers.filter(c => !running.includes(c));
    if (!missing.length || !infra.compose) return { started: false, missing };

    console.info(`[boot] starting ${missing.join(', ')}`);
    const args = ['compose', '-f', infra.compose.file];
    if (infra.compose.envFile) args.push('--env-file', infra.compose.envFile);
    const res = trySh('docker', [...args, 'up', '-d'], { cwd: path.join(ROOT, infra.compose.cwd || '.') });
    return { started: res !== null, missing };
}

/** Runs a configured shell command (migrations, seed) against this worktree's data, output to a log. */
function runDbCommand(env, command, logName) {
    const m = CONFIG.database.migrations;
    fs.mkdirSync(path.join(LOGS, env.name), { recursive: true });
    const logFile = path.join(LOGS, env.name, `${logName}.log`);
    const fd = fs.openSync(logFile, 'a');
    // migration tools log every statement; a piped buffer overflows long before the run ends
    const ok =
        trySh('sh', ['-c', command], {
            cwd: path.join(ROOT, m.cwd || '.'),
            env: { ...process.env, ...isolationEnv(env) },
            stdio: ['ignore', fd, fd],
        }) !== null;
    fs.closeSync(fd);
    return { ok, logFile };
}

/** Creates this worktree's schema or database and migrates + seeds it the first time it is used. */
function ensureData(env) {
    const iso = CONFIG.database?.isolation;
    if (!iso || iso.mode === 'none') return 'shared data (no isolation configured)';
    if (env.isMain) return `${env.schema || env.database} (main checkout — left alone)`;

    const target = iso.mode === 'schema' ? env.schema : env.database;
    const found =
        iso.mode === 'schema'
            ? psql(`select 1 from information_schema.schemata where schema_name = '${env.schema}'`)
            : psql(`select 1 from pg_database where datname = '${env.database}'`);
    if (found === '1') return `${target} (already provisioned)`;

    console.info(`[boot] creating ${iso.mode} ${target}, then migrations + seed (first boot, slow)`);
    const created =
        iso.mode === 'schema'
            ? psql(`create schema if not exists "${env.schema}"`)
            : psql(`create database "${env.database}"`);
    if (created === null) return `${target} (COULD NOT CREATE — is ${CONFIG.database.container} up?)`;

    const m = CONFIG.database.migrations;
    for (const [step, command] of [
        ['migrate', m?.run],
        ['seed', m?.seed],
    ]) {
        if (!command) continue;
        const { ok, logFile } = runDbCommand(env, command, `data-${step}`);
        if (!ok) return `${target} (created; ${step} FAILED — see ${logFile})`;
    }
    return `${target} (created, migrated, seeded)`;
}

// --------------------------------------------------------------- up / down

function spawnArgs(spec, env) {
    const args = (spec.args || []).map(a => fill(a, env, { port: env.ports[spec.name] }));
    if (spec.command)
        return ['sh', ['-c', [fill(spec.command, env, { port: env.ports[spec.name] }), ...args].join(' ')]];
    const [bin, ...filter] = (CONFIG.packageFilter || 'pnpm --filter').split(' ');
    return [bin, [...filter, spec.pkg, 'run', spec.script, ...args]];
}

function up(env, wanted) {
    const registry = readRegistry();
    const mine = registry[env.worktree] || {};
    const pids = { ...(mine.pids || {}) };
    const modes = { ...(mine.modes || {}) };
    const report = [];

    fs.mkdirSync(path.join(LOGS, env.name), { recursive: true });

    for (const surface of wanted) {
        const spec = { ...BOOTABLE[surface], name: surface };
        const port = env.ports[surface];
        const holders = listeners(port);
        const mode = surfaceMode(spec);

        if (holders.length) {
            const ownedByMe = pids[surface] && holders.includes(pids[surface]);
            const owner = Object.entries(registry).find(
                ([p, v]) => p !== env.worktree && holders.includes(v.pids?.[surface]),
            );
            let action = 'IN USE (foreign process)';
            if (ownedByMe) {
                action =
                    mode && modes[surface] && modes[surface] !== mode
                        ? `reused (ours) — but it runs mode ${modes[surface]}, not ${mode}: boot.mjs down, then up again`
                        : 'reused (ours)';
            } else if (owner) action = `IN USE by ${path.basename(owner[0])}`;
            report.push({ surface, port, action, pid: holders[0] });
            continue;
        }

        const surfaceEnv = Object.fromEntries(
            Object.entries(spec.env || {}).map(([k, v]) => [k, fill(v, env, { port })]),
        );
        const apiUrlEnv = Object.fromEntries((CONFIG.apiUrlEnv || []).map(k => [k, env.apiUrl]));
        const logFile = path.join(LOGS, env.name, `${surface}.log`);
        const fd = fs.openSync(logFile, 'a');
        const [bin, args] = spawnArgs(spec, env);
        const child = spawn(bin, args, {
            cwd: path.join(ROOT, spec.cwd || '.'),
            detached: true,
            stdio: ['ignore', fd, fd],
            env: {
                ...process.env,
                ...apiUrlEnv,
                ...(mode ? { [spec.mode.env]: mode } : {}),
                ...surfaceEnv,
                ...isolationEnv(env),
            },
        });
        child.unref();
        pids[surface] = child.pid;
        if (mode) modes[surface] = mode;
        report.push({ surface, port, action: 'started', pid: child.pid, log: logFile });
    }

    registry[env.worktree] = {
        name: env.name,
        slot: env.slot,
        schema: env.schema,
        database: env.database,
        ports: env.ports,
        pids,
        modes,
        updatedAt: new Date().toISOString(),
    };
    writeRegistry(registry);
    return report;
}

const signal = (pid, sig) => {
    try {
        process.kill(-pid, sig);
        return true;
    } catch {
        try {
            process.kill(pid, sig);
            return true;
        } catch {
            return false;
        }
    }
};

/**
 * Dev servers (forge, Electron, Next) get reparented once the process between them and our pid
 * exits, so ancestry no longer proves ownership. A listener on a port this worktree registered,
 * whose command line lives inside this checkout, is ours; another worktree runs from its own path.
 */
function runsFromThisCheckout(pid) {
    const command = trySh('ps', ['-o', 'command=', '-p', String(pid)]) || '';
    const nested = Object.keys(readRegistry()).filter(p => p !== ROOT && p.startsWith(`${ROOT}/`));
    return command.includes(`${ROOT}/`) && !nested.some(p => command.includes(`${p}/`));
}

/** Commands like `node --watch src/www.ts` carry no absolute path; their working directory does. */
function worksInThisCheckout(pid) {
    const out = trySh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']) || '';
    const cwd = out
        .split('\n')
        .find(line => line.startsWith('n'))
        ?.slice(1);
    if (!cwd) return false;
    const inside = dir => cwd === dir || cwd.startsWith(`${dir}/`);
    const nested = Object.keys(readRegistry()).filter(p => p !== ROOT && p.startsWith(`${ROOT}/`));
    return inside(ROOT) && !nested.some(inside);
}

/**
 * What is still alive in a process group we started. A child stuck in a synchronous loop never runs a
 * JS SIGTERM handler (ts-node-dev's child waiting on its compiler did exactly that): it survives the
 * group's SIGTERM, ends up with ppid 1 and burns a core for days, holding no port.
 */
function groupLeftovers(pgid) {
    return (trySh('ps', ['-axo', 'pid=,pgid=']) || '')
        .split('\n')
        .map(line => line.trim().split(/\s+/).map(Number))
        .filter(([pid, group]) => group === pgid && pid !== process.pid)
        .map(([pid]) => pid)
        .filter(pid => runsFromThisCheckout(pid) || worksInThisCheckout(pid));
}

function down(env) {
    const registry = readRegistry();
    const mine = registry[env.worktree];
    if (!mine?.pids) return { report: [], stillHeld: [] };

    const report = [];
    for (const [surface, pid] of Object.entries(mine.pids)) {
        if (!alive(pid)) {
            report.push({ surface, pid, action: 'already gone' });
            continue;
        }
        // dev servers spawn children (webpack, next, electron); killing the group takes them too
        signal(pid, 'SIGTERM');
        report.push({ surface, pid, action: 'stopped' });
    }

    // the leader may be gone while the rest of its group lives on, so every registered group is checked
    const groups = Object.entries(mine.pids);
    for (let attempt = 0; attempt < 6 && groups.some(([, pid]) => groupLeftovers(pid).length); attempt += 1)
        execFileSync('sleep', ['1']);
    for (const [surface, pid] of groups) {
        for (const leftover of groupLeftovers(pid)) {
            signal(leftover, 'SIGKILL');
            report.push({ surface, pid: leftover, action: 'killed (ignored SIGTERM)' });
        }
    }

    // grandchildren can outlive a SIGTERM to the group; escalate only on processes proven ours
    const stillHeld = [];
    const owned = Object.entries(mine.pids).flatMap(([surface, pid]) => {
        const extra = (SURFACES[surface]?.alsoOwns || []).map(p => Number(fill(p, env)));
        return [mine.ports?.[surface], ...extra].filter(Boolean).map(port => [surface, pid, port]);
    });

    for (const [surface, pid, port] of owned) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const holders = listeners(port);
            if (!holders.length) break;
            if (attempt < 3) {
                execFileSync('sleep', ['1']);
                continue;
            }
            const ours = holders.filter(holder => descendsFrom(holder, pid) || runsFromThisCheckout(holder));
            if (!ours.length) {
                stillHeld.push([surface, port, 'foreign process — not killed']);
                break;
            }
            ours.forEach(holder => signal(holder, attempt < 6 ? 'SIGTERM' : 'SIGKILL'));
            execFileSync('sleep', ['1']);
        }

        if (listeners(port).length && !stillHeld.some(([s, p]) => s === surface && p === port)) {
            stillHeld.push([surface, port, 'still listening']);
        }
    }

    delete registry[env.worktree];
    writeRegistry(registry);
    return { report, stillHeld };
}

// -------------------------------------------------------------------- main

const [command = 'env', ...rest] = process.argv.slice(2);
const env = resolveEnv();

const describe = () => {
    console.info(`project    ${CONFIG.name}`);
    console.info(`worktree   ${env.name}${env.isMain ? ' (main checkout)' : ''}`);
    console.info(`slot       ${env.slot}`);
    if (env.isolation === 'schema') console.info(`schema     ${env.schema}`);
    if (env.isolation === 'database') console.info(`database   ${env.database}`);
    if (env.apiUrl) console.info(`API_URL    ${env.apiUrl}`);
    console.info('ports');
    for (const [surface, port] of Object.entries(env.ports)) {
        const held = listeners(port);
        console.info(`  ${surface.padEnd(12)} ${port}${held.length ? `  [in use by pid ${held[0]}]` : ''}`);
    }
};

const flag = name => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
};

if (command === 'env') {
    describe();
} else if (command === 'status') {
    describe();
    const registry = readRegistry();
    console.info('\nregistry');
    for (const [p, v] of Object.entries(registry)) {
        const live = Object.entries(v.pids || {}).filter(([, pid]) => alive(pid));
        console.info(
            `  ${path.basename(p)}  slot ${v.slot}  ${v.schema || v.database || ''}  ${live.length} live: ${
                live.map(([s]) => s).join(', ') || '-'
            }`,
        );
    }
} else if (command === 'up') {
    const wanted = rest.filter(a => !a.startsWith('-'));
    const unknown = wanted.filter(s => !BOOTABLE[s]);
    if (!wanted.length || unknown.length) {
        if (unknown.length) console.error(`unknown or external surface(s): ${unknown.join(', ')}`);
        console.error(`usage: boot.mjs up <surface…>   surfaces: ${Object.keys(BOOTABLE).join(', ')}`);
        Object.entries(BOOTABLE)
            .filter(([, s]) => s.mode)
            .forEach(([name, s]) =>
                console.error(`       ${name} mode: ${s.mode.override}=${(s.mode.values || []).join('|')}`),
            );
        process.exit(1);
    }

    const infra = ensureInfra();
    if (infra.missing.length && !infra.started) {
        console.error(`[boot] could not start ${infra.missing.join(', ')} — is Docker running?`);
        process.exit(1);
    }
    if (CONFIG.database) console.info(`[boot] data: ${ensureData(env)}`);

    const report = up(env, wanted);
    console.info('');
    for (const r of report) {
        console.info(`  ${r.surface.padEnd(12)} :${r.port}  ${r.action}${r.pid ? `  pid ${r.pid}` : ''}`);
        if (r.log) console.info(`  ${''.padEnd(12)} log ${r.log}`);
    }
    const blocked = report.filter(r => r.action.startsWith('IN USE'));
    if (blocked.length) {
        console.info(
            `\n${blocked.length} surface(s) blocked. Nothing was killed — stop them where they were started.`,
        );
        process.exit(2);
    }
} else if (command === 'migrate') {
    const m = CONFIG.database?.migrations;
    if (!m?.run) {
        console.error('no database.migrations.run in .megabrain/config.json');
        process.exit(1);
    }
    const { ok, logFile } = runDbCommand(env, m.run, 'data-migrate');
    console.info(`[migrate] ${env.schema || env.database}: ${ok ? 'done' : 'FAILED'} — log ${logFile}`);
    if (!ok) process.exit(1);
} else if (command === 'seed') {
    const check = rest.includes('--check');
    const fixture = rest.find((a, i) => !a.startsWith('-') && !rest[i - 1]?.startsWith('--'));
    const available = fs.existsSync(FIXTURES)
        ? fs
              .readdirSync(FIXTURES)
              .filter(f => f.endsWith('.sql'))
              .map(f => f.replace(/\.sql$/, ''))
        : [];
    const varSpecs = CONFIG.fixtures?.vars || {};
    if (!fixture || !available.includes(fixture)) {
        const flags = Object.values(varSpecs)
            .map(v => `[${v.flag} <value>]`)
            .join(' ');
        console.error(`usage: boot.mjs seed <fixture> ${flags} [--check]`);
        console.error(`fixtures: ${available.join(', ') || '(none in .megabrain/fixtures)'}`);
        process.exit(1);
    }
    // every fixture runs in one transaction on this worktree's data; --check rolls it back
    const sql = [
        'begin;',
        env.schema ? `set local search_path to "${env.schema}";` : '',
        fs.readFileSync(path.join(FIXTURES, `${fixture}.sql`), 'utf8'),
        check ? 'rollback;' : 'commit;',
    ].join('\n');
    const vars = Object.fromEntries(Object.entries(varSpecs).map(([k, v]) => [k, flag(v.flag) || v.default]));
    try {
        const out = psqlScript(sql, vars, worktreeDatabase(env));
        const counts = out.split('\n').filter(l => /^(INSERT|UPDATE|DELETE)/.test(l));
        console.info(
            `[seed] ${fixture} on ${env.schema || env.database}${check ? ' (checked, rolled back)' : ''}`,
        );
        counts.forEach(c => console.info(`  ${c}`));
    } catch (error) {
        console.error(`[seed] ${fixture} failed on ${env.schema || env.database}, nothing was kept:`);
        console.error(String(error.stderr || error.message).trim());
        process.exit(1);
    }
} else if (command === 'down') {
    const { report, stillHeld } = down(env);
    if (!report.length) {
        console.info('nothing to stop — this worktree has no registered processes');
    } else {
        report.forEach(r => console.info(`  ${r.surface.padEnd(12)} pid ${r.pid}  ${r.action}`));
    }
    if (stillHeld?.length) {
        stillHeld.forEach(([surface, port, why]) => console.info(`  ${surface.padEnd(12)} :${port}  ${why}`));
        process.exit(2);
    }
    console.info('\nall ports registered by this worktree are free');
} else {
    console.info(`boot — per-worktree dev surfaces of ${CONFIG.name}, with isolated data and ports

  boot.mjs env              this worktree's slot, data and ports
  boot.mjs status           the same, plus every registered worktree
  boot.mjs up <surface…>    start only the surfaces given, reusing what is already up
  boot.mjs down             stop only what this worktree started
  boot.mjs migrate          apply pending migrations to this worktree's data
  boot.mjs seed <fixture>   apply .megabrain/fixtures/<fixture>.sql to this worktree's data [--check: roll back]

  surfaces: ${Object.keys(BOOTABLE).join(', ')}

  Ports are 3000 + slot*100 + offset. Surfaces start with ${
      (CONFIG.apiUrlEnv || []).join(', ') || 'no API variable'
  } pointing at this worktree's API.`);
}
