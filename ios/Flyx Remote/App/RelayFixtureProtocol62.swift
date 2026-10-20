#if DEBUG
import Foundation

/// Private generated test media only; this protocol never handles a real provider host.
final class RelayFixtureProtocol62:URLProtocol,@unchecked Sendable{
    override class func canInit(with request:URLRequest)->Bool{request.url?.host=="relay-fixture.invalid"}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){
        guard let url=request.url else{return}
        var type="application/vnd.apple.mpegurl",status=200,body=Data(),length:Int?
        let root=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("relay-fixture")
        if request.value(forHTTPHeaderField:"Cookie") != "fixture=inert" || request.value(forHTTPHeaderField:"Range") != nil{status=403}
        else if url.path=="/root.m3u8"{body=Data("#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"s\",NAME=\"English\",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE=\"en\",URI=\"captions.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180,CODECS=\"avc1.42c00c,mp4a.40.2\",SUBTITLES=\"s\"\nvideo/main.m3u8\n".utf8)}
        else if url.path=="/video/main.m3u8"{body=(try? Data(contentsOf:root.appendingPathComponent("main.m3u8"))) ?? Data();if body.isEmpty{status=404}}
        else if url.path=="/captions.m3u8"{body=Data("#EXTM3U\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:12,\ncaptions.vtt\n#EXT-X-ENDLIST\n".utf8)}
        else if url.path=="/captions.vtt"{type="text/vtt";body=Data("WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nPrivate generated relay check\n\n".utf8)}
        else if url.path=="/oversize.ts"{type="video/mp2t";length=8_388_609}
        else if url.path=="/video/denied.ts"{status=403;type="text/plain"}
        else if url.path.range(of:"^/video/seg[0-9]{1,2}\\.ts$",options:.regularExpression) != nil{
            type="image/png";let data=(try? Data(contentsOf:root.appendingPathComponent(url.lastPathComponent))) ?? Data()
            if data.isEmpty{status=404}else{body=Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!;body.append(data)}
        }else{status=404;type="text/plain"}
        let headers=["Content-Type":type,"Content-Length":String(length ?? body.count)]
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:url,statusCode:status,httpVersion:"HTTP/1.1",headerFields:headers)!,cacheStoragePolicy:.notAllowed)
        if !body.isEmpty{client?.urlProtocol(self,didLoad:body)};client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading(){}
}
extension StandaloneService{
    func debugRelayLease62()throws->Data{
        let source=StandaloneSource(url:URL(string:"https://relay-fixture.invalid/root.m3u8")!,headers:["Cookie":"fixture=inert","Referer":"https://relay-fixture.invalid/"],format:"hls",provider:"Private synthetic HLS",quality:"Auto",language:"en",cookieHost:"relay-fixture.invalid")
        let handle=UUID().uuidString;media[handle] = .init(selection:["contentID":900000062,"season":1,"episode":3],kind:"anime",title:"Private synthetic episode3",sources:[source],resources:["0":source.url,"1":URL(string:"https://other.invalid/private")!,"2":URL(string:"https://relay-fixture.invalid/oversize.ts")!])
        return try json(["handle":handle,"title":"Private synthetic episode3"])
    }
}
#endif
