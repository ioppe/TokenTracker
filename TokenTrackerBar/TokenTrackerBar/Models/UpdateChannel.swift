import Foundation

struct CustomUpdateManifest: Decodable, Sendable {
    let version: String
    let channel: String
    let repository: String
    let source_sha: String
    let build_number: Int
    let build_attempt: Int
    let dmg_sha256: String
}

/// Build metadata selects the update feed; custom builds never fall back to upstream.
struct UpdateChannel: Sendable {
    static let customSuffix = "custom-collectors"
    let repository: String
    let isCustom: Bool
    let buildNumber: Int
    let buildAttempt: Int

    init(info: [String: Any]) {
        isCustom = info["TTUpdateChannel"] as? String == Self.customSuffix
        let configuredRepo = info["TTUpdateRepository"] as? String ?? ""
        repository = isCustom
            ? (configuredRepo.range(of: #"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$"#, options: .regularExpression) != nil
                ? configuredRepo : "ioppe/TokenTracker")
            : "xiufengsun/TokenTracker"
        buildNumber = Int(info["TTUpdateBuildNumber"] as? String ?? "") ?? 0
        buildAttempt = Int(info["TTUpdateBuildAttempt"] as? String ?? "") ?? 0
    }

    var apiURL: URL {
        URL(string: "https://api.github.com/repos/\(repository)/releases\(isCustom ? "?per_page=100" : "/latest")")!
    }

    var releasePageURL: String {
        "https://github.com/\(repository)/releases\(isCustom ? "" : "/latest")"
    }

    func displayVersion(_ version: String) -> String {
        isCustom ? "\(version)-\(Self.customSuffix)" : version
    }

    func accepts(tag: String) -> Bool {
        let value = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        if isCustom {
            guard value.hasSuffix("-\(Self.customSuffix)") else { return false }
        } else if value.contains("-") {
            return false
        }
        return Self.versionParts(value) != nil
    }

    static func versionParts(_ value: String) -> [Int]? {
        var version = value.hasPrefix("v") ? String(value.dropFirst()) : value
        let suffix = "-\(customSuffix)"
        if version.hasSuffix(suffix) { version = String(version.dropLast(suffix.count)) }
        guard version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression) != nil else { return nil }
        let parts = version.split(separator: ".").compactMap { Int($0) }
        return parts.count == 3 ? parts : nil
    }

    static func compareVersions(_ current: String, _ target: String) -> ComparisonResult? {
        guard let a = versionParts(current), let b = versionParts(target) else { return nil }
        for (left, right) in zip(a, b) {
            if left < right { return .orderedAscending }
            if left > right { return .orderedDescending }
        }
        return .orderedSame
    }

    func validates(_ manifest: CustomUpdateManifest, tag: String) -> Bool {
        isCustom && accepts(tag: tag)
            && tag == "v\(manifest.version)-\(Self.customSuffix)"
            && manifest.channel == Self.customSuffix && manifest.repository == repository
            && manifest.build_number > 0 && manifest.build_attempt > 0
            && manifest.source_sha.range(of: #"^[a-f0-9]{40}$"#, options: .regularExpression) != nil
            && manifest.dmg_sha256.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
    }

    func shouldUpdate(current: String, target: String, manifest: CustomUpdateManifest?) -> Bool {
        guard accepts(tag: target), let comparison = Self.compareVersions(current, target) else { return false }
        if comparison == .orderedAscending { return true }
        guard comparison == .orderedSame, isCustom, let manifest else { return false }
        return manifest.build_number > buildNumber
            || (manifest.build_number == buildNumber && manifest.build_attempt > buildAttempt)
    }
}
