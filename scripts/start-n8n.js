#!/usr/bin/env node
'use strict';
/**
 * Starts a local n8n with the Vobiz nodes loaded, for testing. Works on
 * Windows, macOS and Linux.
 *
 *   npm run n8n                          (from this folder)
 *   npm run n8n -- --no-tunnel           (no public address; triggers get no events)
 *   npm run n8n -- --port 5700 --n8n-version 2.37.10
 *
 * What it does:
 *   1. Builds the nodes.
 *   2. Links them into a separate n8n folder, ~/.n8n-vobiz, so your usual n8n
 *      and its workflows are left alone.
 *   3. Opens a free Cloudflare quick tunnel, so Vobiz can reach n8n from the
 *      internet.
 *   4. Starts n8n at http://localhost:5688, with the tunnel as its public address.
 *
 * Press Ctrl+C to stop. The tunnel address changes every time this starts.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WINDOWS = process.platform === 'win32';
const REPO = path.resolve(__dirname, '..');
const USER_FOLDER = path.join(os.homedir(), '.n8n-vobiz');

function option(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : process.argv[index + 1];
}
const N8N_VERSION = option('n8n-version', '2.37.10');
const PORT = Number(option('port', '5688'));
const NO_TUNNEL = process.argv.includes('--no-tunnel');

const cyan = (text) => `\x1b[36m${text}\x1b[0m`;
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;

function fail(message) {
	console.error(`\n${message}`);
	process.exit(1);
}

/** Runs npm synchronously, through the shell on Windows where npm is npm.cmd. */
function npm(args, cwd) {
	return spawnSync('npm', args, { cwd, stdio: 'inherit', shell: WINDOWS }).status;
}

function findOnPath(command) {
	const finder = WINDOWS ? 'where' : 'which';
	const result = spawnSync(finder, [command], { encoding: 'utf8' });
	const first = result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() : '';
	return first || undefined;
}

function findCloudflared() {
	const onPath = findOnPath('cloudflared');
	if (onPath) return onPath;
	const windowsDefault = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
	if (WINDOWS && fs.existsSync(windowsDefault)) return windowsDefault;
	return undefined;
}

function installHint() {
	if (WINDOWS) return 'winget install --id Cloudflare.cloudflared';
	if (process.platform === 'darwin') return 'brew install cloudflared';
	return 'see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

/** Starts a quick tunnel and resolves with its https://….trycloudflare.com address. */
function openTunnel(cloudflared) {
	return new Promise((resolve, reject) => {
		const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const log = fs.createWriteStream(path.join(USER_FOLDER, 'tunnel.log'));
		const timer = setTimeout(() => reject(new Error('The tunnel did not start in 60 seconds.')), 60_000);
		const watch = (chunk) => {
			log.write(chunk);
			const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
			if (match) {
				clearTimeout(timer);
				resolve({ tunnel, publicUrl: match[0] });
			}
		};
		tunnel.stdout.on('data', watch);
		tunnel.stderr.on('data', watch);
		tunnel.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`cloudflared stopped (exit code ${code}).`));
		});
	});
}

/** n8n installed once into the test folder; never globally. */
function ensureN8n() {
	const app = path.join(USER_FOLDER, `n8n-${N8N_VERSION}`);
	const bin = path.join(app, 'node_modules', 'n8n', 'bin', 'n8n');
	if (fs.existsSync(bin)) return bin;
	console.log(cyan(`Downloading n8n ${N8N_VERSION}. This happens once and takes a few minutes...`));
	fs.mkdirSync(app, { recursive: true });
	const status = npm(['install', '--prefix', app, `n8n@${N8N_VERSION}`, '--no-audit', '--no-fund', '--loglevel=error']);
	if (status !== 0 || !fs.existsSync(bin)) {
		fail('Downloading n8n failed. Run  npm run n8n  again; a second try usually works.');
	}
	return bin;
}

async function main() {
	console.log(cyan('\n==> 1/4  Building the Vobiz nodes'));
	if (npm(['run', 'build', '--silent'], REPO) !== 0) fail('The build failed. Scroll up for the error.');

	console.log(cyan(`==> 2/4  Linking them into ${USER_FOLDER}`));
	// n8n loads what is in its custom folder as "CUSTOM" nodes (CUSTOM.vobiz and
	// so on). Only the built files are linked, so n8n doesn't scan node_modules.
	const scope = path.join(USER_FOLDER, '.n8n', 'custom', 'node_modules', '@vobiz');
	fs.mkdirSync(scope, { recursive: true });
	const link = path.join(scope, 'n8n-nodes-vobiz');
	// Replace only a link (it may point at an old copy of this repo); never delete a real folder.
	let existing;
	try {
		existing = fs.lstatSync(link);
	} catch {
		existing = undefined;
	}
	if (existing?.isSymbolicLink()) fs.unlinkSync(link);
	else if (existing) fail(`${link} is a real folder, not a link; move it away first.`);
	fs.symlinkSync(path.join(REPO, 'dist'), link, 'junction');

	let tunnel;
	let publicUrl;
	if (NO_TUNNEL) {
		console.log(yellow('==> 3/4  No tunnel (--no-tunnel): the triggers will not get events from Vobiz'));
	} else {
		console.log(cyan('==> 3/4  Opening a Cloudflare tunnel'));
		const cloudflared = findCloudflared();
		if (!cloudflared) fail(`cloudflared is not installed. Install it with:  ${installHint()}   then run this again.`);
		try {
			({ tunnel, publicUrl } = await openTunnel(cloudflared));
		} catch (error) {
			fail(`${error.message} See ${path.join(USER_FOLDER, 'tunnel.log')}`);
		}
	}

	console.log(cyan('==> 4/4  Starting n8n'));
	const env = {
		...process.env,
		N8N_USER_FOLDER: USER_FOLDER,
		N8N_PORT: String(PORT),
		N8N_RUNNERS_BROKER_PORT: String(PORT + 1),
		N8N_DIAGNOSTICS_ENABLED: 'false',
		N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
		N8N_PERSONALIZATION_ENABLED: 'false',
	};
	// WEBHOOK_URL for n8n up to 2.x; N8N_WEBHOOK_URL is its newer name.
	delete env.WEBHOOK_URL;
	delete env.N8N_WEBHOOK_URL;
	if (publicUrl) {
		env.WEBHOOK_URL = `${publicUrl}/`;
		env.N8N_WEBHOOK_URL = `${publicUrl}/`;
	}

	console.log('');
	console.log(`  Open n8n here:       ${green(`http://localhost:${PORT}`)}`);
	if (publicUrl) console.log(`  Public address:      ${green(publicUrl)}`);
	console.log('  Stop:                Ctrl+C in this window');
	console.log('');

	const n8n = spawn(process.execPath, [ensureN8n(), 'start'], { env, stdio: 'inherit' });
	const stop = () => {
		if (tunnel) tunnel.kill();
	};
	process.on('SIGINT', () => n8n.kill('SIGINT'));
	process.on('SIGTERM', () => n8n.kill('SIGTERM'));
	n8n.on('exit', (code) => {
		stop();
		if (code) console.error(`n8n stopped with exit code ${code}. Scroll up for the reason.`);
		process.exit(code ?? 0);
	});
}

main().catch((error) => fail(error.stack || String(error)));
