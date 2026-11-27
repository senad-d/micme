// Micme MIT source. Build with Xcode 26 and the macOS 26 SDK (arm64);
// Foundation, FoundationModels and the model are provided by macOS. No
// third-party packages, downloaded weights, tools, or network fallback.
import Foundation
#if os(macOS) && arch(arm64) && canImport(FoundationModels)
import FoundationModels
#endif

@main
struct MicmeAppleFinal {
    static func main() async {
        #if os(macOS) && arch(arm64) && canImport(FoundationModels)
        if #available(macOS 26.0, *), case .available = SystemLanguageModel.default.availability {
            do {
                let data = try readRequest()
                let request = try JSONDecoder().decode(Request.self, from: data)
                let session = LanguageModelSession { request.prompt }
                let response = try await session.respond(to: Prompt { request.text })
                try FileHandle.standardOutput.write(contentsOf: Data(response.content.utf8))
                return
            } catch {
                // Never print input, a framework diagnostic, or partial text.
                exit(1)
            }
        }
        #endif
        exit(69) // Unavailable, including Apple Intelligence disabled or not ready.
    }

    private struct Request: Decodable {
        let text: String
        let prompt: String
    }

    private enum InputError: Error { case tooLarge }

    private static func readRequest() throws -> Data {
        let maxBytes = 1_048_576
        var data = Data()
        while let chunk = try FileHandle.standardInput.read(upToCount: 16_384), !chunk.isEmpty {
            guard data.count + chunk.count <= maxBytes else { throw InputError.tooLarge }
            data.append(chunk)
        }
        return data
    }
}
