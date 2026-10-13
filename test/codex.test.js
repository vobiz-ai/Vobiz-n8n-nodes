'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

/*
 * Each node's codex file (<Node>.node.json) describes it for n8n's node panel.
 * In n8n's codex format, nodeVersion and codexVersion are always "1.0": they
 * describe the codex file, not the node. The Vobiz Trigger is version 2 in
 * code, but its codex still says "1.0" (n8n's review flagged "2.0" in 0.3.0).
 * https://docs.n8n.io/integrations/creating-nodes/build/reference/node-codex-files/
 */
const nodes = pkg.n8n.nodes.map((built) => {
	const NodeClass = Object.values(require(path.join(ROOT, built))).find(
		(value) => typeof value === 'function',
	);
	return {
		name: new NodeClass().description.name,
		builtCodex: built.replace(/\.js$/, '.json'),
		sourceCodex: built.replace(/^dist\//, '').replace(/\.js$/, '.json'),
	};
});

test('package.json lists the action node and the trigger node', () => {
	assert.deepEqual(
		nodes.map((n) => n.name),
		['vobiz', 'vobizTrigger'],
	);
});

for (const { name, builtCodex, sourceCodex } of nodes) {
	for (const file of [sourceCodex, builtCodex]) {
		test(`${file}: nodeVersion and codexVersion are "1.0" and it names ${name}`, () => {
			const codex = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
			assert.equal(codex.nodeVersion, '1.0');
			assert.equal(codex.codexVersion, '1.0');
			assert.equal(codex.node, `${pkg.name}.${name}`);
		});
	}
}
