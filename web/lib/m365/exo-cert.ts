// Self-service Exchange Online certificate generator. Produces everything an operator needs to wire
// app-only EXO auth WITHOUT touching openssl/Finder: the public .cer (to upload to the Entra app),
// the PKCS#12 (.pfx) base64 + password (the Delinea CertificateBase64 / CertificatePassword fields),
// and the SHA-1 thumbprint (to verify the uploaded cert matches). Pure (no I/O, no persistence).
import forge from "node-forge";

export type ExoCertResult = {
  cerPem: string; // public certificate PEM — download as exo.cer and upload to the app registration
  pfxBase64: string; // PKCS#12 (private key + cert), base64 — paste into Delinea CertificateBase64
  password: string; // the .pfx password — Delinea CertificatePassword
  thumbprintSha1: string; // uppercase hex, no colons — must match the cert's thumbprint in Entra
  subject: string;
  notAfter: string; // ISO expiry
};

export type ExoCertInput = { password: string; commonName?: string; days?: number };

export async function generateExoCert(input: ExoCertInput): Promise<ExoCertResult> {
  const password = (input.password ?? "").trim();
  if (password.length < 8) throw new Error("the certificate password must be at least 8 characters");
  const cn = (input.commonName ?? "").trim() || "iam-engine-exo";
  const days = Math.min(Math.max(Math.round(input.days ?? 730), 30), 1095); // 30 days .. ~3 years

  // RSA 2048 (EXO requires >=2048). The callback form generates without blocking the event loop.
  const keys = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) =>
    forge.pki.rsa.generateKeyPair({ bits: 2048 }, (err, kp) => (err ? reject(err) : resolve(kp)))
  );

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(8)); // positive serial
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + days * 86_400_000);
  const attrs = [{ name: "commonName", value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", clientAuth: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const cerPem = forge.pki.certificateToPem(cert);

  // PKCS#12 (.pfx) with the password — 3DES content encryption for broad Windows/.NET compatibility.
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  const pfxBase64 = forge.util.encode64(forge.asn1.toDer(p12Asn1).getBytes());

  // SHA-1 thumbprint of the DER cert — the value Entra shows for the uploaded certificate.
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha1.create();
  md.update(certDer);
  const thumbprintSha1 = md.digest().toHex().toUpperCase();

  return { cerPem, pfxBase64, password, thumbprintSha1, subject: cn, notAfter: cert.validity.notAfter.toISOString() };
}
