import CommonCrypto
import Foundation

/// HMAC sign/verify of RPC frames — byte-for-byte compatible with
/// web/lib/sig.js, cli/src/sig.js and the Android Sig.java.
///
/// Canonical form is JS `JSON.stringify(payload, Object.keys(payload).sort())`.
/// The second argument is a key ALLOWLIST that the ES spec applies to *every*
/// object, nested ones included. Since the allowlist only holds top-level key
/// names, nested objects serialise as `{}`. Do not "improve" this into a
/// recursive canonicaliser — it would stop matching the server.
enum Sig {
    static func canonicalize(_ payload: [String: Any]) -> String {
        var out = "{"
        var first = true
        for key in payload.keys.sorted() {
            guard let value = payload[key] else { continue }
            if !first { out += "," }
            first = false
            out += jsonString(key) + ":" + jsonValue(value)
        }
        return out + "}"
    }

    static func sign(secret: String, payload: [String: Any]) -> String {
        let message = Array(canonicalize(payload).utf8)
        let key = Array(secret.utf8)
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), key, key.count, message, message.count, &digest)
        return base64url(Data(digest))
    }

    static func verify(secret: String, payload: [String: Any], sig: String?) -> Bool {
        guard let sig else { return false }
        let expected = sign(secret: secret, payload: payload)
        guard expected.utf8.count == sig.utf8.count else { return false }
        // Constant-time compare, mirroring timingSafeEqual on the Node side.
        var diff: UInt8 = 0
        for (a, b) in zip(expected.utf8, sig.utf8) { diff |= a ^ b }
        return diff == 0
    }

    // MARK: - JS-compatible value rendering

    private static func jsonValue(_ value: Any) -> String {
        if value is NSNull { return "null" }
        if let s = value as? String { return jsonString(s) }
        if let n = value as? NSNumber {
            // NSNumber loses the Bool/Int distinction; the ObjC type tells them apart.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
            return jsNumber(n.doubleValue)
        }
        if let b = value as? Bool { return b ? "true" : "false" }
        // Nested objects collapse to {} — see the note above.
        if value is [String: Any] { return "{}" }
        if let arr = value as? [Any] { return "[" + arr.map(jsonValue).joined(separator: ",") + "]" }
        return "null"
    }

    /// Match JS number formatting: integral values print without a ".0" tail.
    private static func jsNumber(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == d.rounded(), abs(d) < 1e21 { return String(Int64(d)) }
        return String(d)
    }

    private static func jsonString(_ s: String) -> String {
        var out = "\""
        for c in s.unicodeScalars {
            switch c {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{8}": out += "\\b"
            case "\u{c}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if c.value < 0x20 { out += String(format: "\\u%04x", c.value) }
                else { out.unicodeScalars.append(c) }
            }
        }
        return out + "\""
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
