import Foundation

/// Mutable request state and delegate callbacks are confined to the serial delegate queue.
/// The unchecked conformance only bridges URLSession's Objective-C delegate boundary.
/// Remove it when URLSession offers equivalent bounded, chunked async response APIs.
final class BoundedMediaHTTP:NSObject,URLSessionDataDelegate,@unchecked Sendable{
    private struct Entry{let id:UUID;let task:URLSessionDataTask;let limit:Int;let continuation:CheckedContinuation<(Data,HTTPURLResponse),Error>;var response:HTTPURLResponse?;var data=Data();var failure:Error?}
    private let queue=OperationQueue()
    private var session:URLSession!
    private var entries:[Int:Entry]=[:]
    private var cancelled=Set<UUID>()
    init(protocolClasses:[AnyClass]?=nil){
        super.init();queue.maxConcurrentOperationCount=1;queue.name="local.flyx.cast.bounded-http"
        let configuration=URLSessionConfiguration.ephemeral;configuration.httpCookieStorage=nil;configuration.urlCredentialStorage=nil;configuration.timeoutIntervalForRequest=15;configuration.timeoutIntervalForResource=25;configuration.httpMaximumConnectionsPerHost=4
        configuration.protocolClasses=protocolClasses
        session=URLSession(configuration:configuration,delegate:self,delegateQueue:queue)
    }
    func data(for request:URLRequest,limit:Int)async throws->(Data,HTTPURLResponse){
        let id=UUID()
        return try await withTaskCancellationHandler(operation:{
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation{continuation in queue.addOperation{
                if self.cancelled.remove(id) != nil{continuation.resume(throwing:CancellationError());return}
                guard self.entries.count<8,(1...8_388_608).contains(limit) else{continuation.resume(throwing:RemoteFailure(message:"The selected media is busy or exceeds the relay limit."));return}
                let task=self.session.dataTask(with:request);self.entries[task.taskIdentifier]=Entry(id:id,task:task,limit:limit,continuation:continuation);task.resume()
            }}
        },onCancel:{self.queue.addOperation{if let entry=self.entries.values.first(where:{$0.id==id}){entry.task.cancel()}else{if self.cancelled.count>=64{self.cancelled.removeAll()};self.cancelled.insert(id)}}})
    }
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive response:URLResponse,completionHandler:@escaping @Sendable (URLSession.ResponseDisposition)->Void){
        guard var entry=entries[dataTask.taskIdentifier],let http=response as? HTTPURLResponse else{completionHandler(.cancel);return}
        entry.response=http
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--relay-compare63"){Task{await RelayTrace63.shared.event("delegate-response",["status":String(http.statusCode),"declaredBytes":String(http.expectedContentLength)])}}
        #endif
        if http.statusCode>=400{entry.failure=RemoteFailure(message:"The media provider returned HTTP \(http.statusCode).",status:http.statusCode);entries[dataTask.taskIdentifier]=entry;completionHandler(.cancel);return}
        if response.expectedContentLength>Int64(entry.limit){entry.failure=RemoteFailure(message:"This media resource exceeds the bounded relay limit.");entries[dataTask.taskIdentifier]=entry;completionHandler(.cancel);return}
        entries[dataTask.taskIdentifier]=entry;completionHandler(.allow)
    }
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive data:Data){
        guard var entry=entries[dataTask.taskIdentifier] else{return}
        guard data.count<=entry.limit-entry.data.count else{entry.failure=RemoteFailure(message:"This media resource exceeds the bounded relay limit.");entries[dataTask.taskIdentifier]=entry;dataTask.cancel();return}
        entry.data.append(data);entries[dataTask.taskIdentifier]=entry
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,didCompleteWithError error:Error?){
        guard let entry=entries.removeValue(forKey:task.taskIdentifier) else{return}
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--relay-compare63"){let error=(entry.failure ?? error) as NSError?;Task{await RelayTrace63.shared.event("delegate-complete",["bytes":String(entry.data.count),"errorCode":String(error?.code ?? 0),"errorDomain":error?.domain ?? "none"])}}
        #endif
        if let error=entry.failure ?? error{entry.continuation.resume(throwing:error)}else if let response=entry.response{entry.continuation.resume(returning:(entry.data,response))}else{entry.continuation.resume(throwing:RemoteFailure(message:"The media source returned no HTTP response."))}
    }
    func invalidate(){queue.addOperation{self.session.invalidateAndCancel()}}
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping @Sendable (URLRequest?)->Void){completionHandler(nil)}
}

struct RelayByteRange:Sendable,Equatable{
    let first:Int?;let last:Int?
    init(_ raw:String)throws{
        guard raw.hasPrefix("bytes="),!raw.contains(","),raw.count<=48 else{throw RemoteFailure(message:"Unsupported media range.",status:416)}
        let pieces=raw.dropFirst(6).split(separator:"-",omittingEmptySubsequences:false)
        guard pieces.count==2,pieces.allSatisfy({$0.count<=15 && $0.allSatisfy(\.isNumber)}),!pieces.allSatisfy(\.isEmpty) else{throw RemoteFailure(message:"Unsupported media range.",status:416)}
        first=pieces[0].isEmpty ? nil:Int(pieces[0]);last=pieces[1].isEmpty ? nil:Int(pieces[1])
        guard (first != nil || (last ?? 0)>0),first==nil || last==nil || first!<=last! else{throw RemoteFailure(message:"Unsupported media range.",status:416)}
    }
    func bounds(count:Int)throws->Range<Int>{
        guard count>0 else{throw RemoteFailure(message:"Media range unavailable.",status:416)}
        let lower:Int,upper:Int
        if let first{lower=first;upper=min(count-1,last ?? count-1)}else{lower=max(0,count-(last ?? count));upper=count-1}
        guard lower<count,upper>=lower,upper-lower<8_388_608 else{throw RemoteFailure(message:"Media range unavailable.",status:416)}
        return lower..<(upper+1)
    }
}
