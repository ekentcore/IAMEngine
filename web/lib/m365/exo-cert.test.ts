import { test } from "node:test";
import assert from "node:assert/strict";
import forge from "node-forge";
import { generateExoCert } from "./exo-cert";

test("generates a 2048-bit self-signed cert + a .pfx that opens with the password", async () => {
  const r = await generateExoCert({ password: "BayPine06182026", commonName: "iam-engine-exo", days: 730 });

  // public cert is a valid PEM with the requested subject + a 2048-bit key
  assert.match(r.cerPem, /-----BEGIN CERTIFICATE-----/);
  const cert = forge.pki.certificateFromPem(r.cerPem);
  assert.equal(cert.subject.getField("CN").value, "iam-engine-exo");
  assert.equal((cert.publicKey as forge.pki.rsa.PublicKey).n.bitLength(), 2048);

  // the .pfx base64 opens with the password and carries the SAME cert (key + cert bundled)
  const der = forge.util.decode64(r.pfxBase64);
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), "BayPine06182026");
  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0];
  assert.ok(certBag?.cert, "pfx contains the certificate");
  const keyBag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  assert.ok(keyBag?.key, "pfx contains the private key");

  // thumbprint is the SHA-1 of the cert (40 hex, uppercase) — what Entra displays
  assert.match(r.thumbprintSha1, /^[0-9A-F]{40}$/);
  assert.equal(r.password, "BayPine06182026");
});

test("rejects a too-short password", async () => {
  await assert.rejects(() => generateExoCert({ password: "short" }), /at least 8/);
});
