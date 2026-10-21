import Foundation
final class MockState:@unchecked Sendable {let lock=NSLock();var status=200;var body="{\"success\":true}";var requests=0}
final class TMDBMock:URLProtocol,@unchecked Sendable {
 static let state=MockState()
 override class func canInit(with request:URLRequest)->Bool{true}
 override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
 override func startLoading(){let value=Self.state.lock.withLock{Self.state.requests+=1;return(Self.state.status,Self.state.body)};client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:value.0,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:Data(value.1.utf8));client?.urlProtocolDidFinishLoading(self)}
 override func stopLoading(){}
}
@main struct Tests {
 static func main() async throws {
  let key=try TMDBCredential(kind:.apiKey,value:" 0123456789abcdef0123456789abcdef \n"),token=try TMDBCredential(kind:.readAccessToken,value:"eyJsynthetic.payload.signature")
  let k=TMDBAccess.request(path:"/discover/movie",query:[.init(name:"page",value:"2")],credential:key),t=TMDBAccess.request(path:"/authentication",credential:token)
  let q=URLComponents(url:k.url!,resolvingAgainstBaseURL:false)!.queryItems!
  var proof:[String:Bool]=["apiKeyUsesQuery":q.contains{ $0.name=="api_key" && $0.value==key.value },"apiKeyHasNoBearer":k.value(forHTTPHeaderField:"Authorization")==nil,"bearerUsesHeader":t.value(forHTTPHeaderField:"Authorization")=="Bearer "+token.value,"bearerHasNoSecretQuery":t.url?.query==nil,"preservesCatalogueQuery":q.contains{$0.name=="page" && $0.value=="2"},"legacyAPIKeyRecognized":TMDBCredential.legacy(key.value)?.kind == .apiKey,"legacyBearerRecognized":TMDBCredential.legacy(token.value)?.kind == .readAccessToken]
  do{_ = try TMDBCredential(kind:.readAccessToken,value:key.value);proof["wrongKindRejected"]=false}catch{proof["wrongKindRejected"]=true}
  do{_ = try TMDBCredential(kind:.apiKey,value:"not-a-key");proof["invalidKeyRejected"]=false}catch{proof["invalidKeyRejected"]=true}
  let c=URLSessionConfiguration.ephemeral;c.protocolClasses=[TMDBMock.self];let session=URLSession(configuration:c);defer{session.invalidateAndCancel()}
  try await TMDBAccess.validate(key,session:session);try await TMDBAccess.validate(token,session:session);proof["bothKindsValidateAgainstMock"]=true
  for status in [401,403,429,500]{TMDBMock.state.lock.withLock{TMDBMock.state.status=status;TMDBMock.state.body="{\"status_message\":\"SYNTHETIC_SECRET_SHOULD_NOT_BE_SHOWN\"}"};do{try await TMDBAccess.validate(key,session:session);proof["safeError\(status)"]=false}catch{proof["safeError\(status)"] = !error.localizedDescription.contains(key.value) && !error.localizedDescription.contains("SYNTHETIC_SECRET") && !error.localizedDescription.contains("api_key=")}}
  TMDBMock.state.lock.withLock{TMDBMock.state.status=200;TMDBMock.state.body="{\"success\":false}"};do{try await TMDBAccess.validate(key,session:session);proof["falseSuccessRejected"]=false}catch{proof["falseSuccessRejected"]=true}
  guard proof.values.allSatisfy({$0}) else{fatalError("Synthetic TMDB check failed")}
  let data=try JSONSerialization.data(withJSONObject:["checks":proof,"liveCredentialTested":false,"keychainReadOrWrite":false,"realNetworkRequests":0],options:[.prettyPrinted,.sortedKeys]);print(String(decoding:data,as:UTF8.self))
 }
}
