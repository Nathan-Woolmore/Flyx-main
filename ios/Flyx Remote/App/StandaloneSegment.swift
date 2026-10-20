import Foundation

/// This provider carries clear MPEG-TS after a bounded PNG IEND chunk.
/// No decryption, decompression, image decoding, or network retries occur here.
enum StandaloneSegment {
    static let maximumBytes=8*1024*1024
    static func transportStream(_ data:Data)->Data?{
        guard data.count<=maximumBytes else{return nil}
        let bytes=[UInt8](data)
        func valid(_ start:Int)->Bool{
            let count=bytes.count-start
            guard start>=0,count>=188*5,count%188==0 else{return false}
            for offset in stride(from:start,to:bytes.count,by:188){
                // MPEG-TS sync, valid adaptation control, and no transport scrambling.
                guard bytes[offset]==0x47,bytes[offset+3]&0x30 != 0,bytes[offset+3]&0xc0==0 else{return false}
            }
            return true
        }
        if valid(0){return data}
        guard bytes.count>=20,Array(bytes.prefix(8))==[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a] else{return nil}
        var offset=8
        for _ in 0..<4096 {
            guard offset<=bytes.count-12 else{return nil}
            let length=Int(UInt32(bytes[offset])<<24 | UInt32(bytes[offset+1])<<16 | UInt32(bytes[offset+2])<<8 | UInt32(bytes[offset+3]))
            guard length<=bytes.count-offset-12 else{return nil}
            let isEnd=bytes[offset+4]==0x49 && bytes[offset+5]==0x45 && bytes[offset+6]==0x4e && bytes[offset+7]==0x44
            offset+=length+12
            if isEnd {guard length==0,valid(offset) else{return nil};return data.subdata(in:offset..<data.count)}
        }
        return nil
    }
}
