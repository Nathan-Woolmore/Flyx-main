import Foundation
@preconcurrency import Network
import Security

struct PhoneHLSResource:Decodable,Sendable {let bytes:Data;let contentType:String;let status:Int;let contentRange:String?}
// All listener, connection and task state is confined to queue. Only immutable
// request/response values cross network-task boundaries. The credential stays
// in this object and the asset's explicit cookie array; never shared cookie storage.
final class LoopbackHLS:@unchecked Sendable {
    private let queue=DispatchQueue(label:"local.flyx.remote.hls-loopback")
    private let client:RemoteClient
    private let failure:(@Sendable (String)->Void)?
    private let handle:String
    private let secret:String
    private var listener:NWListener?
    private var connections:[ObjectIdentifier:NWConnection]=[:]
    private var tasks:[ObjectIdentifier:Task<Void,Never>]=[:]
    private var starting:CheckedContinuation<URL,Error>?
    private var closed=false
    private var timers:[ObjectIdentifier:DispatchWorkItem]=[:]
    private var origin=""
    #if DEBUG
    private var fixtureResources=Set<String>()
    #endif
    init(client:RemoteClient,handle:String,failure:(@Sendable (String)->Void)?=nil)throws {
        self.client=client;self.handle=handle;self.failure=failure
        var bytes=[UInt8](repeating:0,count:32)
        guard SecRandomCopyBytes(kSecRandomDefault,bytes.count,&bytes)==errSecSuccess else{throw RemoteFailure(message:"Could not secure the local player.")}
        secret=bytes.map{String(format:"%02x",$0)}.joined()
    }
    var cookies:[HTTPCookie] {HTTPCookie(properties:[.domain:"127.0.0.1",.path:"/resource",.name:"flyxLocal",.value:secret,.discard:"TRUE",HTTPCookiePropertyKey("HttpOnly"):"TRUE"]).map{[$0]} ?? []}
    func start()async throws->URL {
        try await withTaskCancellationHandler(operation:{
            try await withCheckedThrowingContinuation{continuation in
                queue.async {
                    guard !self.closed else{continuation.resume(throwing:RemoteFailure(message:"The local HLS player is closed."));return}
                    self.starting=continuation
                    do {
                        let parameters=NWParameters.tcp
                        parameters.requiredLocalEndpoint = .hostPort(host:"127.0.0.1",port:.any)
                        let listener=try NWListener(using:parameters);self.listener=listener
                        listener.stateUpdateHandler={state in
                            switch state {
                            case .ready:
                                guard !self.closed else{listener.cancel();return}
                                guard let port=listener.port else{self.failStart();return}
                                self.origin="http://127.0.0.1:\(port.rawValue)"
                                self.starting?.resume(returning:URL(string:self.origin+"/resource/0")!);self.starting=nil
                            case .failed(_),.cancelled:self.failStart()
                            default:break
                            }
                        }
                        listener.newConnectionHandler={connection in
                            guard !self.closed,self.connections.count<8 else{connection.cancel();return}
                            let id=ObjectIdentifier(connection);self.connections[id]=connection
                            let timeout=DispatchWorkItem{connection.cancel();self.connections.removeValue(forKey:id);self.timers.removeValue(forKey:id)};self.timers[id]=timeout;self.queue.asyncAfter(deadline:.now()+5,execute:timeout)
                            connection.start(queue:self.queue);self.receive(connection,id:id,prefix:Data())
                        }
                        listener.start(queue:self.queue)
                    }catch{self.starting?.resume(throwing:RemoteFailure(message:"The local HLS player could not start."));self.starting=nil}
                }
            }
        },onCancel:{self.stop()})
    }
    private func failStart(){starting?.resume(throwing:RemoteFailure(message:"The local HLS player stopped."));starting=nil}
    private func receive(_ connection:NWConnection,id:ObjectIdentifier,prefix:Data){
        connection.receive(minimumIncompleteLength:1,maximumLength:8192){data,_,complete,error in
            guard !self.closed,self.connections[id] != nil else{return}
            var bytes=prefix;if let data{bytes.append(data)}
            guard bytes.count<=8192,error==nil else{self.reply(connection,id:id,status:400,type:"text/plain",body:Data());return}
            guard let text=String(data:bytes,encoding:.utf8),text.contains("\r\n\r\n") else{
                if complete{self.reply(connection,id:id,status:400,type:"text/plain",body:Data())}else{self.receive(connection,id:id,prefix:bytes)};return
            }
            self.timers.removeValue(forKey:id)?.cancel()
            let lines=text.components(separatedBy:"\r\n"),parts=lines[0].split(separator:" ")
            var headers:[String:String]=[:]
            for line in lines.dropFirst() where !line.isEmpty {guard let colon=line.firstIndex(of:":") else{continue};let key=line[..<colon].lowercased();guard headers[key]==nil else{self.reply(connection,id:id,status:400,type:"text/plain",body:Data());return};headers[key]=line[line.index(after:colon)...].trimmingCharacters(in:.whitespaces)}
            guard parts.count==3,parts[0]=="GET",String(parts[1]).range(of:"^/resource/[0-9]{1,5}$",options:.regularExpression) != nil,headers["origin"]==nil,headers["host"]==self.origin.replacingOccurrences(of:"http://",with:""),headers["transfer-encoding"]==nil,(headers["content-length"] ?? "0")=="0" else{self.reply(connection,id:id,status:403,type:"text/plain",body:Data());return}
            let supplied=headers["cookie"]?.components(separatedBy:";").map{$0.trimmingCharacters(in:.whitespaces)} ?? []
            guard supplied.contains("flyxLocal="+self.secret) else{
#if DEBUG
if ProcessInfo.processInfo.arguments.contains(where:{$0.hasPrefix("details-hls") || $0=="--standalone-movie54" || $0=="fullscreen-lifecycle70"}){UIOnlyProtocol.probe(["hlsUnauthenticatedRefused":true])}
#endif
self.reply(connection,id:id,status:401,type:"text/plain",body:Data());return}
            let resourceID=String(parts[1].split(separator:"/").last!),range=headers["range"]
            if let range,range.range(of:"^bytes=[0-9]{1,15}-[0-9]{0,15}$",options:.regularExpression)==nil{self.reply(connection,id:id,status:400,type:"text/plain",body:Data());return}
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains(where:{$0.hasPrefix("details-hls") || $0=="--standalone-movie54" || $0=="fullscreen-lifecycle70"}){self.fixtureResources.insert(resourceID);UIOnlyProtocol.probe(["hlsResourceIDs":Array(self.fixtureResources).sorted(),"hlsLocalRequestsAuthenticated":true,"hlsListenerHost":"127.0.0.1"])}
            #endif
            self.tasks[id]=Task {
                do {
                    let value:PhoneHLSResource=try await self.client.request("/remote/v1/media",body:JSONEncoder().encode(PhoneMediaOperation(operation:"resource",handle:self.handle,resourceID:resourceID,range:range)))
                    try Task.checkCancellation()
                    guard [200,206].contains(value.status),value.bytes.count<=8_388_608 else{throw RemoteFailure(message:"Invalid HLS resource")}
                    var body=value.bytes
                    if value.contentType=="application/vnd.apple.mpegurl" {
                        let playlist=String(decoding:body,as:UTF8.self).replacingOccurrences(of:"flyx-resource://([0-9]+)",with:self.origin+"/resource/$1",options:.regularExpression)
                        body=Data(playlist.utf8)
                    }
                    let result=body
                    self.queue.async{self.reply(connection,id:id,status:value.status,type:value.contentType,body:result,contentRange:value.contentRange)}
                }catch{self.failure?((error as? RemoteFailure)?.message ?? "The media connection failed. Close and retry this title.");self.queue.async{self.reply(connection,id:id,status:502,type:"text/plain",body:Data())}}
            }
        }
    }
    private func reply(_ connection:NWConnection,id:ObjectIdentifier,status:Int,type:String,body:Data,contentRange:String?=nil){
        guard !closed,connections[id] != nil else{return}
        let allowed=["application/vnd.apple.mpegurl","video/mp2t","video/mp4","audio/aac","audio/mp4","application/octet-stream","text/plain"]
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--standalone-movie54"),!allowed.contains(type){UIOnlyProtocol.probe(["movieLocalRejectedMIME":type,"movieLocalRejectedBytes":body.count])}
        #endif
        guard allowed.contains(type) else{connection.cancel();connections.removeValue(forKey:id);tasks.removeValue(forKey:id);return}
        var headers="HTTP/1.1 \(status) Response\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n"
        if let contentRange,contentRange.range(of:"^bytes [0-9]+-[0-9]+/[0-9]+$",options:.regularExpression) != nil{headers+="Content-Range: \(contentRange)\r\nAccept-Ranges: bytes\r\n"}
        var response=Data((headers+"\r\n").utf8);response.append(body)
        connection.send(content:response,completion:.contentProcessed{_ in connection.cancel();self.connections.removeValue(forKey:id);self.tasks.removeValue(forKey:id);self.timers.removeValue(forKey:id)?.cancel()})
    }
    func isUsable()async->Bool{await withCheckedContinuation{continuation in queue.async{if !self.closed,let listener=self.listener,case .ready=listener.state{continuation.resume(returning:true)}else{continuation.resume(returning:false)}}}}
    func stop(){queue.async{self.closed=true;self.listener?.newConnectionHandler=nil;self.listener?.stateUpdateHandler=nil;self.listener?.cancel();self.listener=nil;self.failStart();self.tasks.values.forEach{$0.cancel()};self.tasks.removeAll();self.timers.values.forEach{$0.cancel()};self.timers.removeAll();self.connections.values.forEach{$0.cancel()};self.connections.removeAll()}}
}
