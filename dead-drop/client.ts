#!/usr/bin/env npx tsx
/**
 * Dead Drop client — helper for encrypting, uploading, and depositing payloads.
 *
 * Orchestrates the full client-side flow:
 *   1. Get a per-drop encryption key from the dead-drop flow
 *   2. Encrypt the payload locally with AES-256-GCM
 *   3. Get a presigned IPFS upload URL from the ipfs-upload flow
 *   4. Upload the encrypted blob directly to Pinata
 *   5. Deposit the CID with the dead-drop flow
 *
 * Usage:
 *   # Encrypt + upload + deposit a file
 *   npx tsx examples/dead-drop/client.ts deposit \
 *     --drop-id 0 --role a --file ./dataset.json
 *
 *   # Encrypt + upload + deposit a string
 *   npx tsx examples/dead-drop/client.ts deposit \
 *     --drop-id 0 --role a --data '{"entries": [...]}'
 *
 *   # Just encrypt a file (no upload)
 *   npx tsx examples/dead-drop/client.ts encrypt \
 *     --drop-id 0 --role a --file ./dataset.json --out ./dataset.enc
 *
 *   # Download + decrypt after release
 *   npx tsx examples/dead-drop/client.ts decrypt \
 *     --cid QmAbc... --key 0xdef... --out ./received-payload.json
 *
 * Required env:
 *   MUR_API_KEY — API key for the Murmuration platform
 *   MUR_BASE_URL — (optional) override base URL (default: https://usemur.dev)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { webcrypto } from 'node:crypto';

const crypto = webcrypto as unknown as Crypto;

// ── CLI parsing ─────────────────────────────────────────────────

const { positionals, values } = parseArgs({
  options: {
    'drop-id': { type: 'string' },
    'role': { type: 'string' },
    'file': { type: 'string' },
    'data': { type: 'string' },
    'out': { type: 'string' },
    'cid': { type: 'string' },
    'key': { type: 'string' },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0];
if (!command || !['deposit', 'encrypt', 'decrypt'].includes(command)) {
  console.error('Usage: client.ts <deposit|encrypt|decrypt> [options]');
  console.error('  deposit  — encrypt + upload to IPFS + deposit CID');
  console.error('  encrypt  — encrypt locally (no upload)');
  console.error('  decrypt  — download from IPFS + decrypt');
  process.exit(1);
}

const BASE_URL = process.env.MUR_BASE_URL ?? 'https://usemur.dev';
const API_KEY = process.env.MUR_API_KEY;
if (!API_KEY && command !== 'decrypt') {
  console.error('✗ MUR_API_KEY is required');
  process.exit(1);
}

// ── Crypto helpers ──────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function encrypt(plaintext: Uint8Array, keyHex: string): Promise<Uint8Array> {
  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext,
  );
  // Format: [12-byte IV][ciphertext + GCM tag]
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

async function decrypt(encrypted: Uint8Array, keyHex: string): Promise<Uint8Array> {
  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'],
  );
  const iv = encrypted.slice(0, 12);
  const ciphertextWithTag = encrypted.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertextWithTag,
  );
  return new Uint8Array(plaintext);
}

// ── Murmuration API helpers ───────────────────────────────────────────

async function invokeFlow(slug: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/api/flows/${slug}/invoke`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ params }),
  });
  const data = await res.json() as Record<string, unknown>;
  if (res.status !== 200) {
    throw new Error(`Flow ${slug} error (${res.status}): ${JSON.stringify(data).slice(0, 500)}`);
  }
  let result: Record<string, unknown>;
  if (typeof data.result === 'string') {
    try { result = JSON.parse(data.result); } catch { result = { raw: data.result }; }
  } else {
    result = data.result as Record<string, unknown>;
  }
  if (result.error) {
    throw new Error(`Flow ${slug} returned error: ${result.error}`);
  }
  return result;
}

// ── Commands ────────────────────────────────────────────────────

async function cmdDeposit() {
  const dropId = parseInt(values['drop-id'] as string);
  const role = values['role'] as string;
  if (isNaN(dropId) || !role) {
    console.error('✗ --drop-id and --role are required');
    process.exit(1);
  }

  // Read payload
  let payload: Uint8Array;
  if (values['file']) {
    payload = readFileSync(values['file'] as string);
    console.log(`  → Read ${payload.length} bytes from ${values['file']}`);
  } else if (values['data']) {
    payload = new TextEncoder().encode(values['data'] as string);
    console.log(`  → Using inline data (${payload.length} bytes)`);
  } else {
    console.error('✗ --file or --data is required');
    process.exit(1);
  }

  // 1. Get encryption key
  console.log(`\n  ━━━ Step 1: Get encryption key ━━━`);
  const keyResult = await invokeFlow('dead-drop', {
    action: 'get-key', dropId, role,
  });
  const encryptionKey = keyResult.encryptionKey as string;
  console.log(`  → Key: ${encryptionKey.slice(0, 16)}...`);
  console.log(`  → Algorithm: ${keyResult.algorithm}`);

  // 2. Encrypt locally
  console.log(`\n  ━━━ Step 2: Encrypt payload ━━━`);
  const encrypted = await encrypt(payload, encryptionKey);
  console.log(`  → Encrypted: ${encrypted.length} bytes (payload: ${payload.length})`);

  // 3. Get presigned upload URL
  console.log(`\n  ━━━ Step 3: Get IPFS upload URL ━━━`);
  const uploadResult = await invokeFlow('ipfs-upload', {
    filename: `dead-drop-${dropId}-${role}.enc`,
    maxSize: encrypted.length + 1024, // small buffer
  });
  const uploadUrl = uploadResult.uploadUrl as string;
  const gateway = uploadResult.gateway as string;
  console.log(`  → Upload URL: ${uploadUrl.slice(0, 80)}...`);

  // 4. Upload encrypted blob to Pinata
  console.log(`\n  ━━━ Step 4: Upload to IPFS ━━━`);
  const blob = new Blob([encrypted]);
  const form = new FormData();
  form.append('file', blob, `dead-drop-${dropId}-${role}.enc`);

  const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form });
  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`Pinata upload failed (${uploadRes.status}): ${text.slice(0, 500)}`);
  }
  const uploadData = await uploadRes.json() as { data?: { cid?: string } };
  const cid = uploadData.data?.cid;
  if (!cid) {
    throw new Error(`No CID in Pinata response: ${JSON.stringify(uploadData).slice(0, 500)}`);
  }
  console.log(`  → CID: ${cid}`);
  console.log(`  → IPFS URL: ${gateway}${cid}`);

  // 5. Deposit CID with dead-drop flow
  console.log(`\n  ━━━ Step 5: Deposit CID ━━━`);
  const depositResult = await invokeFlow('dead-drop', {
    action: 'deposit', dropId, role, cid,
  });
  console.log(`  → Status: ${depositResult.status}`);
  console.log(`  → Commitment: ${depositResult.commitment}`);

  console.log(`\n  ✓ Done! CID ${cid} deposited for drop ${dropId} side ${role}`);
  console.log(`  → Share this CID with the other party or use it for on-chain deposit`);
}

async function cmdEncrypt() {
  const dropId = parseInt(values['drop-id'] as string);
  const role = values['role'] as string;
  if (isNaN(dropId) || !role) {
    console.error('✗ --drop-id and --role are required');
    process.exit(1);
  }

  let payload: Uint8Array;
  if (values['file']) {
    payload = readFileSync(values['file'] as string);
  } else if (values['data']) {
    payload = new TextEncoder().encode(values['data'] as string);
  } else {
    console.error('✗ --file or --data is required');
    process.exit(1);
  }

  const keyResult = await invokeFlow('dead-drop', {
    action: 'get-key', dropId, role,
  });
  const encryptionKey = keyResult.encryptionKey as string;
  const encrypted = await encrypt(payload, encryptionKey);

  const outPath = (values['out'] as string) || `dead-drop-${dropId}-${role}.enc`;
  writeFileSync(outPath, encrypted);
  console.log(`  → Encrypted ${payload.length} bytes → ${encrypted.length} bytes`);
  console.log(`  → Written to ${outPath}`);
}

async function cmdDecrypt() {
  const cid = values['cid'] as string;
  const keyHex = values['key'] as string;
  if (!cid || !keyHex) {
    console.error('✗ --cid and --key are required');
    process.exit(1);
  }

  // Fetch from IPFS
  const gateway = 'https://gateway.pinata.cloud/ipfs/';
  console.log(`  → Fetching ${gateway}${cid}...`);
  const res = await fetch(`${gateway}${cid}`);
  if (!res.ok) {
    throw new Error(`IPFS fetch failed (${res.status})`);
  }
  const encrypted = new Uint8Array(await res.arrayBuffer());
  console.log(`  → Downloaded ${encrypted.length} bytes`);

  // Decrypt
  const plaintext = await decrypt(encrypted, keyHex);
  console.log(`  → Decrypted: ${plaintext.length} bytes`);

  // Write output
  const outPath = values['out'] as string;
  if (outPath) {
    writeFileSync(outPath, plaintext);
    console.log(`  → Written to ${outPath}`);
  } else {
    // Try to print as text
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
      console.log(`\n${text}`);
    } catch {
      console.log(`  → Binary data (${plaintext.length} bytes). Use --out to save to file.`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────

if (command === 'deposit') await cmdDeposit();
else if (command === 'encrypt') await cmdEncrypt();
else if (command === 'decrypt') await cmdDecrypt();
