import XCTest

final class UpdateChannelTests: XCTestCase {
    private let customInfo: [String: Any] = [
        "TTUpdateChannel": "custom-collectors", "TTUpdateRepository": "ioppe/TokenTracker",
        "TTUpdateBuildNumber": "12", "TTUpdateBuildAttempt": "1",
    ]

    private func manifest(build: Int = 13, attempt: Int = 1, version: String = "1.1.9", repo: String = "ioppe/TokenTracker") -> CustomUpdateManifest {
        CustomUpdateManifest(version: version, channel: "custom-collectors", repository: repo,
                             source_sha: String(repeating: "a", count: 40), build_number: build,
                             build_attempt: attempt, dmg_sha256: String(repeating: "b", count: 64))
    }

    func testOfficialBuildKeepsOfficialLatestFeed() {
        let channel = UpdateChannel(info: [:])
        XCTAssertEqual(channel.apiURL.absoluteString, "https://api.github.com/repos/xiufengsun/TokenTracker/releases/latest")
        XCTAssertEqual(channel.displayVersion("1.1.9"), "1.1.9")
        XCTAssertFalse(channel.accepts(tag: "v1.1.10-custom-collectors"))
    }

    func testCustomBuildOnlyAcceptsCustomReleasesIncludingPrereleases() {
        let channel = UpdateChannel(info: customInfo)
        XCTAssertEqual(channel.repository, "ioppe/TokenTracker")
        XCTAssertEqual(channel.apiURL.absoluteString, "https://api.github.com/repos/ioppe/TokenTracker/releases?per_page=100")
        XCTAssertTrue(channel.accepts(tag: "v1.1.9-custom-collectors"))
        XCTAssertFalse(channel.accepts(tag: "v1.1.10"))
        XCTAssertFalse(channel.accepts(tag: "nightly"))
        XCTAssertFalse(channel.accepts(tag: "v1.1.9-custom-collectors-extra"))
        XCTAssertEqual(channel.displayVersion("1.1.9"), "1.1.9-custom-collectors")
    }

    func testInvalidCustomRepositoryNeverFallsBackToUpstream() {
        let channel = UpdateChannel(info: ["TTUpdateChannel": "custom-collectors", "TTUpdateRepository": "../bad"])
        XCTAssertEqual(channel.repository, "ioppe/TokenTracker")
    }

    func testSuffixedVersionsRetainThePatchComponent() {
        XCTAssertEqual(UpdateChannel.compareVersions("1.1.9-custom-collectors", "1.1.10-custom-collectors"), .orderedAscending)
        XCTAssertEqual(UpdateChannel.compareVersions("1.1.9", "v1.1.9-custom-collectors"), .orderedSame)
        XCTAssertNil(UpdateChannel.compareVersions("1.1.invalid", "1.1.10"))
    }

    func testSameVersionRebuildUpdatesWithoutDowngradingOrLooping() {
        let channel = UpdateChannel(info: customInfo)
        XCTAssertTrue(channel.shouldUpdate(current: "1.1.9", target: "1.1.9-custom-collectors", manifest: manifest()))
        XCTAssertTrue(channel.shouldUpdate(current: "1.1.9", target: "1.1.9-custom-collectors", manifest: manifest(build: 12, attempt: 2)))
        XCTAssertFalse(channel.shouldUpdate(current: "1.1.9", target: "1.1.9-custom-collectors", manifest: manifest(build: 12)))
        XCTAssertFalse(channel.shouldUpdate(current: "1.1.9", target: "1.1.8-custom-collectors", manifest: manifest(version: "1.1.8")))
        XCTAssertFalse(channel.shouldUpdate(current: "1.1.9", target: "1.1.10", manifest: nil))
    }

    func testManifestMustMatchRepositoryVersionAndChannel() {
        let channel = UpdateChannel(info: customInfo)
        XCTAssertTrue(channel.validates(manifest(), tag: "v1.1.9-custom-collectors"))
        XCTAssertFalse(channel.validates(manifest(repo: "xiufengsun/TokenTracker"), tag: "v1.1.9-custom-collectors"))
        XCTAssertFalse(channel.validates(manifest(version: "1.1.8"), tag: "v1.1.9-custom-collectors"))
        XCTAssertFalse(channel.validates(manifest(build: 0), tag: "v1.1.9-custom-collectors"))
    }
}
