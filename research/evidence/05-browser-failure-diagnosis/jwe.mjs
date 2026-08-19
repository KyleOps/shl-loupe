// Verify the exact WebCrypto-only decrypt path a zero-backend viewer would ship.
const b64u = { dec: s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice(0,(4-s.length%4)%4)), c=>c.charCodeAt(0)),
               enc: b => btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') };
const te = new TextEncoder(), td = new TextDecoder();

// --- MINT a spec-shaped SHL JWE: alg=dir, enc=A256GCM, cty=application/fhir+json
const rawKey = crypto.getRandomValues(new Uint8Array(32));
const shlKey = b64u.enc(rawKey);
console.log('shlink key ("key" field):', shlKey, '-> length', shlKey.length);
const protectedHeader = { alg:'dir', enc:'A256GCM', cty:'application/fhir+json' };
const protHdrB64 = b64u.enc(te.encode(JSON.stringify(protectedHeader)));
const iv = crypto.getRandomValues(new Uint8Array(12));
const plaintext = te.encode(JSON.stringify({resourceType:'Bundle', type:'collection', entry:[]}));
const k = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt','decrypt']);
const ctAndTag = new Uint8Array(await crypto.subtle.encrypt(
  { name:'AES-GCM', iv, additionalData: te.encode(protHdrB64), tagLength:128 }, k, plaintext));
const ct = ctAndTag.slice(0, ctAndTag.length-16), tag = ctAndTag.slice(ctAndTag.length-16);
const compact = [protHdrB64, '', b64u.enc(iv), b64u.enc(ct), b64u.enc(tag)].join('.');
console.log('compact JWE (5 parts, empty 2nd):', compact.slice(0,80)+'…', 'parts=', compact.split('.').length);

// --- DECRYPT exactly as the viewer would, from (compact, shlKey) alone
async function decryptShlFile(compact, keyB64u) {
  const p = compact.split('.');
  if (p.length !== 5) throw new Error(`not a compact JWE: ${p.length} dot-separated parts, expected 5`);
  const [hdrB64, encryptedKey, ivB64, ctB64, tagB64] = p;
  const hdr = JSON.parse(td.decode(b64u.dec(hdrB64)));
  if (hdr.alg !== 'dir')      throw new Error(`unsupported "alg": ${hdr.alg} (SHL requires "dir")`);
  if (hdr.enc !== 'A256GCM')  throw new Error(`unsupported "enc": ${hdr.enc} (SHL requires "A256GCM")`);
  if (encryptedKey !== '')    throw new Error('"dir" requires an empty JWE Encrypted Key, got a value');
  const raw = b64u.dec(keyB64u);
  if (raw.length !== 32)      throw new Error(`key is ${raw.length} bytes, A256GCM needs 32 (43 base64url chars)`);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const ctTag = new Uint8Array(b64u.dec(ctB64).length + b64u.dec(tagB64).length);
  ctTag.set(b64u.dec(ctB64), 0); ctTag.set(b64u.dec(tagB64), b64u.dec(ctB64).length);
  const pt = await crypto.subtle.decrypt(
    { name:'AES-GCM', iv: b64u.dec(ivB64), additionalData: new TextEncoder().encode(hdrB64), tagLength:128 }, key, ctTag);
  let bytes = new Uint8Array(pt);
  if (hdr.zip === 'DEF') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  return { header: hdr, text: td.decode(bytes) };
}
console.log('DECRYPTED:', JSON.stringify(await decryptShlFile(compact, shlKey)));
// wrong-key behaviour (what the viewer must report)
try { await decryptShlFile(compact, b64u.enc(crypto.getRandomValues(new Uint8Array(32)))); }
catch(e){ console.log('WRONG KEY ->', e.constructor.name, '|', e.name, '|', JSON.stringify(e.message)); }
// truncated ciphertext
try { await decryptShlFile(compact.slice(0,compact.length-4), shlKey); }
catch(e){ console.log('TRUNCATED ->', e.constructor.name, '|', e.name, '|', JSON.stringify(e.message)); }
// zip=DEF round trip
const defProt = b64u.enc(te.encode(JSON.stringify({alg:'dir',enc:'A256GCM',zip:'DEF',cty:'application/fhir+json'})));
const iv2 = crypto.getRandomValues(new Uint8Array(12));
const deflated = new Uint8Array(await new Response(new Blob([plaintext]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
const ct2 = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:iv2,additionalData:te.encode(defProt),tagLength:128}, k, deflated));
const compact2 = [defProt,'',b64u.enc(iv2),b64u.enc(ct2.slice(0,ct2.length-16)),b64u.enc(ct2.slice(ct2.length-16))].join('.');
console.log('zip=DEF DECRYPTED:', JSON.stringify(await decryptShlFile(compact2, shlKey)));
