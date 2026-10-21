import Foundation
import Security
import CryptoKit

final class PinnedSessionDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    let host: String
    let fingerprint: String
    init(host: String, fingerprint: String) { self.host=host.lowercased();self.fingerprint=fingerprint.lowercased().replacingOccurrences(of:":",with:"") }
    static func matches(certificate: Data, fingerprint: String) -> Bool {
        let digest=SHA256.hash(data:certificate).map { String(format:"%02x",$0) }.joined()
        return digest == fingerprint.lowercased().replacingOccurrences(of:":",with:"")
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host.lowercased() == host,
              let trust=challenge.protectionSpace.serverTrust,
              let chain=SecTrustCopyCertificateChain(trust) as? [SecCertificate],let leaf=chain.first,
              Self.matches(certificate:SecCertificateCopyData(leaf) as Data,fingerprint:fingerprint) else { completionHandler(.cancelAuthenticationChallenge,nil);return }
        SecTrustSetPolicies(trust,SecPolicyCreateSSL(true,host as CFString))
        SecTrustSetAnchorCertificates(trust,[leaf] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust,true)
        var trustError: CFError?
        let accepted=SecTrustEvaluateWithError(trust,&trustError)
        guard accepted else { completionHandler(.cancelAuthenticationChallenge,nil);return }
        completionHandler(.useCredential,URLCredential(trust:trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
