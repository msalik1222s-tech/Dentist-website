// Makes Node trust the machine's own certificate store, in addition to the CA
// list it ships with.
//
// Why this exists: security software that inspects HTTPS — Avast, Kaspersky,
// ESET, Zscaler, many corporate proxies — terminates TLS locally and re-signs
// every certificate with a private root it installs into the operating system
// store. Browsers and curl read that store and are fine. Node does not: it
// uses its own bundled CA list, so every outbound HTTPS call fails with
//
//     UNABLE_TO_VERIFY_LEAF_SIGNATURE / unable to verify the first certificate
//
// which the OpenAI SDK surfaces as a bare "Connection error" and the chat
// widget reports as "temporarily unavailable" — with nothing wrong with the
// API key, the network, or the code.
//
// The usual workaround is the NODE_EXTRA_CA_CERTS environment variable
// pointing at the vendor's .pem. That works only for shells where it happens
// to be set, which makes the assistant work in one terminal and fail in
// another on the same machine. Reading the system store directly is not
// dependent on a variable being inherited.
//
// This is called ONLY from backend/server.js, the local entry point. The
// Vercel function (api/index.js) never runs it: a serverless host has no
// antivirus intercepting its traffic, and its CA handling should be left
// exactly as the platform sets it.

const tls = require("tls");

function trustSystemCAs() {
  // Added in Node 22.15 / 24. On older versions there is nothing to do here
  // and NODE_EXTRA_CA_CERTS remains the answer.
  if (typeof tls.getCACertificates !== "function" || typeof tls.setDefaultCACertificates !== "function") {
    return { applied: false, reason: "this Node version has no system CA API" };
  }

  try {
    const system = tls.getCACertificates("system");
    if (!system || !system.length) return { applied: false, reason: "the system store returned no certificates" };

    // A union, never a replacement: the defaults already include Node's
    // bundled roots plus anything from NODE_EXTRA_CA_CERTS, and dropping
    // those would trade one broken configuration for another.
    const current = tls.getCACertificates("default");
    const merged = [...new Set([...current, ...system])];
    const added = merged.length - current.length;
    if (added <= 0) return { applied: false, reason: "the system roots were already trusted" };

    tls.setDefaultCACertificates(merged);
    return { applied: true, added };
  } catch (err) {
    // Never let a certificate-store problem stop the server booting. The
    // worst case is the status quo: outbound HTTPS fails and says so.
    return { applied: false, reason: err.message };
  }
}

module.exports = { trustSystemCAs };
