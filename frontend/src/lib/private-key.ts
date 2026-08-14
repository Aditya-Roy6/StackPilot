/**
 * Reads and validates an SSH private key file picked in the browser.
 *
 * The file never leaves the page except through the field it fills, which is
 * the same path a pasted key takes: HTTPS to the backend, encrypted at rest.
 * There is deliberately no upload endpoint — adding one would mean a second
 * place a private key can be logged, buffered or written to a temp file.
 *
 * Validation exists because the failure it prevents is miserable to debug. A
 * key that is subtly wrong — CRLF line endings, a stray copy of the *public*
 * key, a PuTTY .ppk — produces "Permission denied (publickey)" from the remote
 * host, which reads like a server problem rather than a file problem.
 */

export interface ParsedPrivateKey {
    ok: boolean;
    key: string;
    /** Human-readable problem, when ok is false. */
    error?: string;
    /** e.g. "OpenSSH", "RSA", "EC" — shown so the user can sanity-check it. */
    format?: string;
    /** Non-fatal notes, such as a normalisation we applied. */
    notes: string[];
}

const HEADERS: Array<{ marker: string; format: string }> = [
    { marker: "BEGIN OPENSSH PRIVATE KEY", format: "OpenSSH" },
    { marker: "BEGIN RSA PRIVATE KEY", format: "RSA (PEM)" },
    { marker: "BEGIN EC PRIVATE KEY", format: "EC (PEM)" },
    { marker: "BEGIN DSA PRIVATE KEY", format: "DSA (PEM)" },
    { marker: "BEGIN PRIVATE KEY", format: "PKCS#8" },
    { marker: "BEGIN ENCRYPTED PRIVATE KEY", format: "PKCS#8 (encrypted)" },
];

export function parsePrivateKey(raw: string): ParsedPrivateKey {
    const notes: string[] = [];
    let text = raw;

    // A key saved on Windows, or pasted through some editors, carries CRLF.
    // OpenSSH rejects it outright, so normalise rather than making the user
    // discover this from a permission-denied message.
    if (text.includes("\r")) {
        text = text.replace(/\r\n?/g, "\n");
        notes.push("Converted Windows line endings to Unix");
    }

    // A trailing newline is required by OpenSSH; its absence is a classic
    // cause of "invalid format".
    text = text.replace(/\s+$/, "") + "\n";

    if (!text.trim()) {
        return { ok: false, key: "", error: "That file is empty.", notes };
    }

    // Wrong-file cases, each with a specific message. "Invalid key" would be
    // technically correct and completely unhelpful.
    if (/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-|ssh-dss)\s/.test(text.trim())) {
        return {
            ok: false,
            key: "",
            error: "That is a public key (.pub). Pick the private key file instead — usually the same name without .pub.",
            notes,
        };
    }
    if (text.startsWith("PuTTY-User-Key-File")) {
        return {
            ok: false,
            key: "",
            error: "That is a PuTTY .ppk file. Export it as OpenSSH from PuTTYgen (Conversions → Export OpenSSH key) and upload that.",
            notes,
        };
    }

    const matched = HEADERS.find((entry) => text.includes(entry.marker));
    if (!matched) {
        return {
            ok: false,
            key: "",
            error: "That does not look like a private key. Expected a file beginning with -----BEGIN ... PRIVATE KEY-----.",
            notes,
        };
    }

    if (!text.includes("-----END")) {
        return {
            ok: false,
            key: "",
            error: "The key looks truncated — its -----END----- line is missing.",
            notes,
        };
    }

    // An encrypted key cannot be used unattended. Better to say so now than to
    // have every connection attempt fail later.
    if (matched.marker === "BEGIN ENCRYPTED PRIVATE KEY" || /Proc-Type:.*ENCRYPTED/.test(text)) {
        return {
            ok: false,
            key: "",
            error: "That key is passphrase-protected. StackPilot connects unattended, so remove the passphrase first: ssh-keygen -p -f <keyfile>",
            notes,
        };
    }

    return { ok: true, key: text, format: matched.format, notes };
}

/** Reads a File as text. Rejects anything implausibly large for a key. */
export async function readPrivateKeyFile(file: File): Promise<ParsedPrivateKey> {
    // A real key is a few kilobytes. A larger file is a mistake, and reading it
    // into a textarea would hang the tab.
    const MAX_BYTES = 64 * 1024;
    if (file.size > MAX_BYTES) {
        return {
            ok: false,
            key: "",
            error: `That file is ${Math.round(file.size / 1024)} KB. A private key is normally under a few KB — check you picked the right file.`,
            notes: [],
        };
    }
    try {
        return parsePrivateKey(await file.text());
    } catch {
        return { ok: false, key: "", error: "Could not read that file.", notes: [] };
    }
}
