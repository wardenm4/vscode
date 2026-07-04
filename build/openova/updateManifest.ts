/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generates the static auto-update manifest (latest.json) Openova clients poll.
// The manifest lives in the public releases repo under
//   updates/<quality>/<platform>/latest.json
// and the client treats `version === product.commit` as "already up to date".
//
// Usage:
//   node --experimental-strip-types build/openova/updateManifest.ts \
//     --file <setup.exe|archive.zip> --url <public download url> \
//     --commit <build commit sha> --productVersion <x.y.z> --out <latest.json>

import * as crypto from 'crypto';
import * as fs from 'fs';

function arg(name: string): string {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1 || i === process.argv.length - 1) {
		console.error(`Missing required argument --${name}`);
		process.exit(1);
	}
	return process.argv[i + 1];
}

function digest(file: string, algorithm: string): string {
	const h = crypto.createHash(algorithm);
	h.update(fs.readFileSync(file));
	return h.digest('hex');
}

const file = arg('file');
const manifest = {
	url: arg('url'),
	name: arg('productVersion'),
	version: arg('commit'),
	productVersion: arg('productVersion'),
	hash: digest(file, 'sha1'),
	sha256hash: digest(file, 'sha256'),
	timestamp: Date.now(),
	supportsFastUpdate: true
};

fs.writeFileSync(arg('out'), JSON.stringify(manifest, undefined, '\t') + '\n');
console.log(`Wrote ${arg('out')} for ${manifest.productVersion} (${manifest.version})`);
