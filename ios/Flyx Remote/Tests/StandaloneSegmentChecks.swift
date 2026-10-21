import Foundation

@main struct StandaloneSegmentChecks {
static func main(){
var ts=Data(repeating:0,count:188*5)
for p in stride(from:0,to:ts.count,by:188){ts[p]=0x47;ts[p+3]=0x10}
let png=Data([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0,0x49,0x45,0x4e,0x44,0,0,0,0])
precondition(StandaloneSegment.transportStream(ts)==ts)
precondition(StandaloneSegment.transportStream(png+ts)==ts)
precondition(StandaloneSegment.transportStream(png)==nil)
precondition(StandaloneSegment.transportStream(png+ts.dropLast())==nil)
var scrambled=ts;scrambled[3]=0x90;precondition(StandaloneSegment.transportStream(png+scrambled)==nil)
var invalid=png;invalid[8]=0xff;precondition(StandaloneSegment.transportStream(invalid+ts)==nil)
precondition(StandaloneSegment.transportStream(Data(repeating:0,count:StandaloneSegment.maximumBytes+1))==nil)
print("Segment parser: 7 focused bounds/format checks passed")

}
}
