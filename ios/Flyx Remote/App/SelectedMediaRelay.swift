import Foundation
@preconcurrency import Network
import Security

/// One selected media lease only. All mutable listener/request state lives on queue.
/// @unchecked bridges Network's callback boundary; the client and binding are immutable.
/// No URL or filesystem path supplied by an HTTP client reaches the upstream fetcher.
final class SelectedMediaRelay:@unchecked Sendable{
    private let queue=DispatchQueue(label:"local.flyx.selected-cast-media")
    private let binding:PrivateLANBinding
    private let fetch:@Sendable (String,String?)async throws->PhoneHLSResource
    private let failure:@Sendable (String)->Void
    private let secret:String
    private var origin=""
    private var listener:NWListener?
    private var connections:[ObjectIdentifier:NWConnection]=[:]
    private var tasks:[ObjectIdentifier:Task<Void,Never>]=[:]
    private var deadlines:[ObjectIdentifier:DispatchWorkItem]=[:]
    private var responding=Set<ObjectIdentifier>()
    private var starting:CheckedContinuation<URL,Error>?
    private var expiry:DispatchSourceTimer?
    private var closed=false
    private var started=Date()
    private var lastRequest=Date()
    private var rateWindow=Date()
    private var requestCount=0
    private let idleLimit:TimeInterval
    private static let origins=Set(["https://www.gstatic.com","https://cast.google.com","https://cast.gstatic.com"])
    init(client:RemoteClient,handle:String,sourceID:String,binding:PrivateLANBinding,failure:@escaping @Sendable(String)->Void)throws{
        self.binding=binding;self.failure=failure;idleLimit=120
        fetch={id,range in try await client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"cast-resource",handle:handle,resourceID:id,range:range,sourceID:sourceID)))}
        var random=[UInt8](repeating:0,count:32);guard SecRandomCopyBytes(kSecRandomDefault,random.count,&random)==errSecSuccess else{throw RemoteFailure(message:"Could not secure TV media playback.")};secret=random.map{String(format:"%02x",$0)}.joined()
        guard let local=PrivateLANBinding.ipv4(binding.address),let peer=PrivateLANBinding.ipv4(binding.receiver),PrivateLANBinding.isPrivate(local),PrivateLANBinding.isPrivate(peer),binding.interface.hasPrefix("en") else{throw RemoteFailure(message:"A private Wi-Fi interface is required for TV playback.")}
    }
    #if DEBUG
    /// Uses the production HTTP handler with a loopback-only surrogate. Never used in a Cast payload.
    init(testClient:RemoteClient,handle:String,sourceID:String,idleLimit:TimeInterval=120,failure:@escaping @Sendable(String)->Void={_ in})throws{
        binding = .init(address:"127.0.0.1",receiver:"127.0.0.1",interface:"debug-loopback");self.failure=failure;self.idleLimit=idleLimit
        fetch={id,range in try await testClient.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"cast-resource",handle:handle,resourceID:id,range:range,sourceID:sourceID)))}
        var random=[UInt8](repeating:0,count:32);guard SecRandomCopyBytes(kSecRandomDefault,random.count,&random)==errSecSuccess else{throw RemoteFailure(message:"Could not secure the relay test.")};secret=random.map{String(format:"%02x",$0)}.joined()
    }
    #endif
    func start()async throws->URL{
        try await withTaskCancellationHandler(operation:{try await withCheckedThrowingContinuation{continuation in queue.async{
            guard !self.closed,self.listener==nil else{continuation.resume(throwing:RemoteFailure(message:"The TV media connection is closed."));return}
            self.starting=continuation;self.started=Date();self.lastRequest=Date()
            do{
                let parameters=NWParameters.tcp;parameters.requiredLocalEndpoint = .hostPort(host:NWEndpoint.Host(self.binding.address),port:.any);parameters.includePeerToPeer=false
                let listener=try NWListener(using:parameters);self.listener=listener
                listener.stateUpdateHandler={state in switch state{case .ready:
                    guard !self.closed,let port=listener.port else{self.close();return};self.origin="http://\(self.binding.address):\(port.rawValue)";self.starting?.resume(returning:URL(string:self.origin+"/cast/"+self.secret+"/0")!);self.starting=nil
                case .failed(_),.cancelled:self.close();default:break}}
                listener.newConnectionHandler={connection in self.accept(connection)};listener.start(queue:self.queue)
                let expiry=DispatchSource.makeTimerSource(queue:self.queue);expiry.schedule(deadline:.now()+1,repeating:1);expiry.setEventHandler{[weak self] in guard let self,!self.closed else{return};let now=Date();if self.starting != nil,now.timeIntervalSince(self.started)>8{self.close();self.failure("The TV media server could not start. Check Local Network access and Wi-Fi.")};if now.timeIntervalSince(self.lastRequest)>self.idleLimit || now.timeIntervalSince(self.started)>4*60*60{self.close();self.failure("The TV media connection expired. Choose Cast to TV again.")}};self.expiry=expiry;expiry.resume()
            }catch{self.close()}
        }}},onCancel:{self.stop()})
    }
    static func acceptsPeer(_ address:String,expected:String)->Bool{address==expected}
    private func accept(_ connection:NWConnection){
        guard !closed,connections.count<4,case .hostPort(let host,_) = connection.endpoint,Self.acceptsPeer(String(describing:host),expected:binding.receiver) else{
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--relay-compare63"){let count=connections.count;Task{await RelayTrace63.shared.event("connection-rejected",["active":String(count)])}}
            #endif
            connection.cancel();return
        }
        let id=ObjectIdentifier(connection);connections[id]=connection;connection.start(queue:queue)
        setDeadline(connection,id:id,seconds:5);receive(connection,id:id,prefix:Data())
    }
    private func setDeadline(_ connection:NWConnection,id:ObjectIdentifier,seconds:Double){
        deadlines.removeValue(forKey:id)?.cancel();let item=DispatchWorkItem{self.tasks[id]?.cancel();self.reply(connection,id:id,status:504,type:"text/plain",body:Data())};deadlines[id]=item;queue.asyncAfter(deadline:.now()+seconds,execute:item)
    }
    private func receive(_ connection:NWConnection,id:ObjectIdentifier,prefix:Data){
        connection.receive(minimumIncompleteLength:1,maximumLength:8192){data,_,complete,error in
            guard !self.closed,self.connections[id] != nil else{return};var bytes=prefix;if let data{bytes.append(data)}
            guard bytes.count<=8192,error==nil else{self.reply(connection,id:id,status:400,type:"text/plain",body:Data());return}
            guard let text=String(data:bytes,encoding:.utf8),text.contains("\r\n\r\n") else{if complete{self.reply(connection,id:id,status:400,type:"text/plain",body:Data())}else{self.receive(connection,id:id,prefix:bytes)};return}
            let lines=text.components(separatedBy:"\r\n"),parts=lines[0].split(separator:" ");var headers:[String:String]=[:]
            guard lines.count<=52,parts.count==3,["HTTP/1.1","HTTP/1.0"].contains(String(parts[2])) else{self.reply(connection,id:id,status:400,type:"text/plain",body:Data());return}
            for line in lines.dropFirst() where !line.isEmpty{guard let colon=line.firstIndex(of:":") else{self.reply(connection,id:id,status:400,type:"text/plain",body:Data());return};let key=line[..<colon].lowercased();guard headers[key]==nil else{self.reply(connection,id:id,status:400,type:"text/plain",body:Data());return};headers[key]=line[line.index(after:colon)...].trimmingCharacters(in:.whitespaces)}
            let method=String(parts[0]),path=String(parts[1]),base="/cast/"+self.secret+"/"
            guard ["GET","HEAD","OPTIONS"].contains(method),headers["host"]==String(self.origin.dropFirst(7)),headers["transfer-encoding"]==nil,(headers["content-length"] ?? "0")=="0",text.components(separatedBy:"\r\n\r\n").last=="" else{self.reply(connection,id:id,status:403,type:"text/plain",body:Data());return}
            guard path.hasPrefix(base),String(path.dropFirst(base.count)).range(of:"^[0-9]{1,5}$",options:.regularExpression) != nil else{self.reply(connection,id:id,status:401,type:"text/plain",body:Data());return}
            let origin=headers["origin"];guard origin==nil || Self.origins.contains(origin!) else{self.reply(connection,id:id,status:403,type:"text/plain",body:Data());return}
            if Date().timeIntervalSince(self.rateWindow)>=1{self.rateWindow=Date();self.requestCount=0};self.requestCount+=1
            guard self.requestCount<=32 else{self.reply(connection,id:id,status:429,type:"text/plain",body:Data());return}
            if let range=headers["range"],(try? RelayByteRange(range))==nil{self.reply(connection,id:id,status:416,type:"text/plain",body:Data(),origin:origin);return}
            if method=="OPTIONS"{self.reply(connection,id:id,status:204,type:"text/plain",body:Data(),origin:origin);return}
            self.lastRequest=Date();self.setDeadline(connection,id:id,seconds:30)
            let resource=String(path.dropFirst(base.count)),range=headers["range"],rewritePrefix=self.origin+"/cast/"+self.secret+"/"
            self.tasks[id]=Task{
                do{
                    let value=try await self.fetch(resource,range);try Task.checkCancellation()
                    guard [200,206].contains(value.status),value.bytes.count<=8_388_608 else{throw RemoteFailure(message:"The selected media resource is unsupported.")}
                    var body=value.bytes
                    if value.contentType=="application/vnd.apple.mpegurl"{body=try Self.rewritePlaylist(body,prefix:rewritePrefix)}
                    let result=body
                    self.queue.async{self.reply(connection,id:id,status:value.status,type:value.contentType,body:result,head:method=="HEAD",range:value.contentRange,origin:origin)}
                }catch{
                    let status=(error as? RemoteFailure)?.status ?? 502,message=(error as? RemoteFailure)?.message ?? "TV media playback failed. Return to iPhone and try again."
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--relay-compare63"){Task{await RelayTrace63.shared.event("relay-resource-error",["id":resource,"status":String(status),"message":message])}}
                    #endif
                    self.queue.async{self.reply(connection,id:id,status:[403,404,416,451].contains(status) ? status:502,type:"text/plain",body:Data(),origin:origin,after:{self.failure(message)})}
                }
            }
        }
    }
    private static func rewritePlaylist(_ data:Data,prefix:String)throws->Data{
        guard let text=String(data:data,encoding:.utf8),text.hasPrefix("#EXTM3U") else{throw RemoteFailure(message:"The selected HLS playlist is invalid.")}
        let replacement=prefix
        for line in text.components(separatedBy:.newlines) where !line.isEmpty && !line.hasPrefix("#"){
            guard line.range(of:"^flyx-resource://[0-9]{1,5}$",options:.regularExpression) != nil else{throw RemoteFailure(message:"This playlist contains an unsupported media address.")}
        }
        let attributes=try NSRegularExpression(pattern:"URI=\"([^\"]+)\"")
        for match in attributes.matches(in:text,range:NSRange(text.startIndex...,in:text)){guard let r=Range(match.range(at:1),in:text),text[r].range(of:"^flyx-resource://[0-9]{1,5}$",options:.regularExpression) != nil else{throw RemoteFailure(message:"This playlist contains an unsupported media address.")}}
        return Data(text.replacingOccurrences(of:"flyx-resource://([0-9]{1,5})",with:replacement+"$1",options:.regularExpression).utf8)
    }
    private func reply(_ connection:NWConnection,id:ObjectIdentifier,status:Int,type:String,body:Data,head:Bool=false,range:String?=nil,origin:String?=nil,after:(@Sendable()->Void)?=nil){
        guard !closed,connections[id] != nil,responding.insert(id).inserted else{return}
        deadlines.removeValue(forKey:id)?.cancel()
        let allowed=Set(["application/vnd.apple.mpegurl","video/mp2t","video/mp4","audio/aac","audio/mp4","application/octet-stream","text/plain","text/vtt","application/ttml+xml"])
        guard allowed.contains(type),body.count<=8_388_608 else{finish(connection,id:id);failure("The TV does not support this media format.");return}
        var response="HTTP/1.1 \(status) Response\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\nAccept-Ranges: bytes\r\n"
        if let range,range.range(of:"^bytes [0-9]+-[0-9]+/[0-9]+$",options:.regularExpression) != nil{response+="Content-Range: \(range)\r\n"}
        if let origin{response+="Access-Control-Allow-Origin: \(origin)\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nAccess-Control-Max-Age: 60\r\n"}
        var bytes=Data((response+"\r\n").utf8);if !head{bytes.append(body)}
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--relay-compare63"){let count=body.count;Task{await RelayTrace63.shared.event("relay-response",["status":String(status),"bytes":String(count),"type":type])}}
        #endif
        connection.send(content:bytes,completion:.contentProcessed{_ in self.finish(connection,id:id);after?()})
    }
    private func finish(_ connection:NWConnection,id:ObjectIdentifier){connection.cancel();connections.removeValue(forKey:id);tasks.removeValue(forKey:id);responding.remove(id);deadlines.removeValue(forKey:id)?.cancel()}
    private func close(){guard !closed else{return};closed=true;listener?.newConnectionHandler=nil;listener?.stateUpdateHandler=nil;listener?.cancel();listener=nil;starting?.resume(throwing:RemoteFailure(message:"The TV media connection closed."));starting=nil;expiry?.setEventHandler{};expiry?.cancel();expiry=nil;tasks.values.forEach{$0.cancel()};tasks.removeAll();deadlines.values.forEach{$0.cancel()};deadlines.removeAll();connections.values.forEach{$0.cancel()};connections.removeAll();responding.removeAll()}
    func stop(){queue.async{self.close()}}
}
