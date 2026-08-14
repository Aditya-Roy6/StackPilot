import { describe, expect, it } from "vitest";

import { parsePrivateKey } from "./private-key";

// The point of this parser is not to validate cryptography — it is to turn the
// four mistakes people actually make into a sentence that says what to do,
// instead of "Permission denied (publickey)" twenty minutes later.

const openssh = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

const rsa = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF0qJ5xZ6mFQ4vJ0Yl0Kj0Xk8kQ==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe("accepting real keys", () => {
  it("accepts an OpenSSH key", () => {
    const result = parsePrivateKey(openssh);
    expect(result.ok).toBe(true);
    expect(result.format).toBe("OpenSSH");
  });

  it("accepts a classic PEM RSA key, which is what AWS hands out", () => {
    const result = parsePrivateKey(rsa);
    expect(result.ok).toBe(true);
    expect(result.format).toBe("RSA (PEM)");
  });

  it("accepts PKCS#8", () => {
    const result = parsePrivateKey(
      "-----BEGIN PRIVATE KEY-----\nMIIEvQ==\n-----END PRIVATE KEY-----"
    );
    expect(result.ok).toBe(true);
  });
});

describe("normalisation", () => {
  it("converts CRLF, which OpenSSH rejects outright", () => {
    const result = parsePrivateKey(openssh.replace(/\n/g, "\r\n"));
    expect(result.ok).toBe(true);
    expect(result.key).not.toContain("\r");
    expect(result.notes.join(" ")).toContain("line endings");
  });

  it("guarantees the trailing newline OpenSSH requires", () => {
    // Its absence is a classic cause of "invalid format" on an otherwise
    // perfect key.
    const result = parsePrivateKey(openssh.trimEnd());
    expect(result.ok).toBe(true);
    expect(result.key.endsWith("\n")).toBe(true);
  });

  it("does not leave a pile of blank lines at the end", () => {
    const result = parsePrivateKey(openssh + "\n\n\n\n");
    expect(result.key.endsWith("KEY-----\n")).toBe(true);
  });
});

describe("rejecting the wrong file, with a usable reason", () => {
  it("names a public key as a public key", () => {
    const result = parsePrivateKey("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ user@host");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("public key");
  });

  it("recognises an ed25519 public key too", () => {
    const result = parsePrivateKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI user@host");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("public key");
  });

  it("tells a PuTTY user how to convert", () => {
    const result = parsePrivateKey("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("PuTTYgen");
  });

  it("refuses a passphrase-protected key, because connections are unattended", () => {
    const result = parsePrivateKey(
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF==\n-----END ENCRYPTED PRIVATE KEY-----"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ssh-keygen -p");
  });

  it("catches the legacy Proc-Type encryption marker", () => {
    const result = parsePrivateKey(
      [
        "-----BEGIN RSA PRIVATE KEY-----",
        "Proc-Type: 4,ENCRYPTED",
        "DEK-Info: AES-128-CBC,ABCDEF",
        "",
        "MIIEpAIBAAKCAQEA",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n")
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("passphrase");
  });

  it("spots a truncated key", () => {
    const result = parsePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blb");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("truncated");
  });

  it("rejects an empty file", () => {
    expect(parsePrivateKey("").ok).toBe(false);
    expect(parsePrivateKey("   \n  ").ok).toBe(false);
  });

  it("rejects arbitrary text without pretending to know what it is", () => {
    const result = parsePrivateKey("hello world");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("BEGIN");
  });

  it("never returns a key alongside a failure", () => {
    // A partially-accepted key would be written into the field and fail later
    // at connection time, which is the outcome this whole module exists to
    // prevent.
    for (const bad of ["", "hello", "ssh-rsa AAAA", "PuTTY-User-Key-File-3: x"]) {
      expect(parsePrivateKey(bad).key).toBe("");
    }
  });
});
