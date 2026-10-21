import Foundation
import Security

struct RememberedConnection: Codable, Sendable {
    let endpoint: String
    let certificatePin: String
    let token: String
    let deviceID: String
    var scopes: [String]
    var pendingApproval: Bool
    func validate() throws {
        guard let url=URLComponents(string:endpoint),url.scheme=="https",url.host?.hasSuffix(".local")==true,url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,
              url.path.isEmpty || url.path=="/",certificatePin.range(of:"^[a-fA-F0-9]{64}$",options:.regularExpression) != nil,
              (43...512).contains(token.count),!deviceID.isEmpty else {throw RemoteFailure(message:"Invalid prepared phone connection")}
    }
}
struct RestoredSession: Decodable, Sendable {let deviceID:String;let scopes:[String];let expiresAt:Double}

/// One paired Mac, protected by the app's own non-synchronizing, this-device-only Keychain group.
protocol RememberedConnectionStorage {
    func save(_ value: RememberedConnection) throws
    func load() throws -> RememberedConnection?
    func importPreparedEnrollment() throws
}

final class RememberedConnectionStore: RememberedConnectionStorage {
    private let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"local.flyx.remote.pairing",kSecAttrAccount as String:"paired-mac",kSecAttrSynchronizable as String:false]
    func save(_ value:RememberedConnection)throws {
        try value.validate();let bytes=try JSONEncoder().encode(value)
        let attributes:[String:Any]=[kSecValueData as String:bytes,kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status=SecItemUpdate(query as CFDictionary,attributes as CFDictionary)
        if status==errSecItemNotFound {status=SecItemAdd(query.merging(attributes){_,new in new} as CFDictionary,nil)}
        guard status==errSecSuccess else {throw RemoteFailure(message:"Could not securely remember this Mac")}
    }
    func load()throws->RememberedConnection? {
        var result:CFTypeRef?;let request=query.merging([kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]){_,new in new}
        let status=SecItemCopyMatching(request as CFDictionary,&result)
        if status==errSecItemNotFound{return nil}
        guard status==errSecSuccess,let bytes=result as? Data else {throw RemoteFailure(message:"Unlock your iPhone to restore this connection")}
        let value=try JSONDecoder().decode(RememberedConnection.self,from:bytes);try value.validate();return value
    }
    func remove(){SecItemDelete(query as CFDictionary)}
    func importPreparedEnrollment()throws {
        let file=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent(".flyx-enrollment.json")
        guard FileManager.default.fileExists(atPath:file.path) else{return}
        let bytes=try Data(contentsOf:file);guard bytes.count<16384 else {throw RemoteFailure(message:"Prepared connection is invalid")}
        let value=try JSONDecoder().decode(RememberedConnection.self,from:bytes);try save(value)
        try FileManager.default.removeItem(at:file)
    }
}
