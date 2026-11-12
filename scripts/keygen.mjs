// Prints a new Ed25519 signing key for ATTESTATION_PRIVATE_KEY (one line, \n-escaped for env vars).
import { generateKeyPairSync } from "node:crypto";
const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
console.log(pem.trim().replace(/\n/g, "\\n"));
