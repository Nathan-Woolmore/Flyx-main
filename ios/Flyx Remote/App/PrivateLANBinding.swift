import Foundation
import Darwin

struct PrivateLANBinding:Sendable{
    let address:String;let receiver:String;let interface:String
    static func ipv4(_ value:String)->UInt32?{
        let pieces=value.split(separator:".",omittingEmptySubsequences:false)
        guard pieces.count==4 else{return nil};var result:UInt32=0
        for piece in pieces{guard let byte=UInt8(piece),String(byte)==piece else{return nil};result=(result<<8)|UInt32(byte)}
        return result
    }
    static func isPrivate(_ value:UInt32)->Bool{value>>24==10 || value>>20==0xac1 || value>>16==0xc0a8}
    static func choose(receiver:String,candidates:[(String,String,String)])throws->PrivateLANBinding{
        guard let target=ipv4(receiver),isPrivate(target) else{throw RemoteFailure(message:"A nearby TV on the same private Wi-Fi network is required.")}
        for (name,address,mask) in candidates{
            guard name.hasPrefix("en"),let local=ipv4(address),let netmask=ipv4(mask),netmask != 0,netmask != UInt32.max,isPrivate(local),local != target else{continue}
            let inverse = ~netmask;guard inverse & (inverse &+ 1)==0,local & netmask == target & netmask else{continue}
            return .init(address:address,receiver:receiver,interface:name)
        }
        throw RemoteFailure(message:"No matching Wi-Fi address is available. Connect iPhone and TV to the same private network and try again.")
    }
    static func select(receiver:String)throws->PrivateLANBinding{
        var first:UnsafeMutablePointer<ifaddrs>?;guard getifaddrs(&first)==0 else{throw RemoteFailure(message:"The iPhone Wi-Fi address is unavailable.")};defer{freeifaddrs(first)}
        var result:[(String,String,String)]=[],current=first
        func address(_ raw:UnsafeMutablePointer<sockaddr>)->String?{var text=[CChar](repeating:0,count:Int(INET_ADDRSTRLEN));guard getnameinfo(raw,socklen_t(raw.pointee.sa_len),&text,socklen_t(text.count),nil,0,NI_NUMERICHOST)==0 else{return nil};return String(decoding:text.prefix{$0 != 0}.map{UInt8(bitPattern:$0)},as:UTF8.self)}
        while let pointer=current{let item=pointer.pointee;current=item.ifa_next;guard let addr=item.ifa_addr,addr.pointee.sa_family==AF_INET,let mask=item.ifa_netmask,item.ifa_flags & UInt32(IFF_UP|IFF_RUNNING)==UInt32(IFF_UP|IFF_RUNNING),item.ifa_flags & UInt32(IFF_LOOPBACK)==0,let ip=address(addr),let netmask=address(mask) else{continue};result.append((String(cString:item.ifa_name),ip,netmask))}
        return try choose(receiver:receiver,candidates:result)
    }
}
