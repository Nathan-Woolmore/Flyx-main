// No network, JavaScript execution or credential access. Optional arguments read local captured provider pages.
import Foundation
@main struct EmbedChecks {
 static func main()throws {
  let page=URL(string:"https://www.2embed.cc/embed/tt10872600")!, expected="https://vidsrc.buzz/embed/movie/634649"
  var checks:[String:Bool]=[:]
  let accepted:[(String,String,String)]=[
   ("currentMarkup","<iframe id=\"iframesrc\" src=\"about:blank\" data-src=\"\(expected)\"></iframe>",expected),
   ("singleQuotes","<iframe id='iframesrc' data-src='\(expected)'></iframe>",expected),
   ("attributeSpacing","<iframe id = 'iframesrc' data-src = '\(expected)'></iframe>",expected),
   ("upperCaseTags","<IFRAME ID='iframesrc' DATA-SRC='\(expected)'></IFRAME>",expected),
   ("protocolRelative","<iframe id='iframesrc' data-src='//vidsrc.buzz/embed/movie/634649'></iframe>",expected),
   ("loadedIframeSrc","<iframe id='iframesrc' src='\(expected)'></iframe>",expected),
   ("ignoresUnrelatedDataSrc","<img data-src=\"https://ads.invalid/banner\"><iframe id='iframesrc' data-src='\(expected)'></iframe>",expected),
   ("namedPlayerWins","<iframe data-src='https://ads.invalid/frame'></iframe><iframe id='iframesrc' data-src='\(expected)'></iframe>",expected),
   ("legacyUnnamedIframe","<iframe data-src=\"\(expected)\"></iframe>",expected),
   ("escapedQuery","<iframe id='iframesrc' data-src='https://videm.xyz/embed/movie/634649?a=1&amp;b=2'></iframe>","https://videm.xyz/embed/movie/634649?a=1&b=2")]
  for(name,html,url)in accepted{checks[name]=try StandaloneEmbedPlayer.resolve(html:html,pageURL:page).absoluteString==url}
  let rejected:[(String,String)]=[
   ("noPlayer","<html>Temporarily unavailable</html>"),
   ("dropdownIsNotPlayer","<a onclick=\"go('\(expected)')\">Vsrc</a>"),
   ("unrelatedElementIsNotPlayer","<img data-src='\(expected)'>"),
   ("noAlternateAfterUnsupportedDefault","<iframe id='iframesrc' data-src='https://other.invalid/player'></iframe><iframe data-src='\(expected)'></iframe>"),
   ("noHTTP","<iframe id='iframesrc' data-src='http://vidsrc.buzz/embed/movie/634649'></iframe>"),
   ("noUserInfo","<iframe id='iframesrc' data-src='https://user:password@vidsrc.buzz/embed/movie/634649'></iframe>"),
   ("noCustomPort","<iframe id='iframesrc' data-src='https://vidsrc.buzz:8443/embed/movie/634649'></iframe>"),
   ("noHostSuffix","<iframe id='iframesrc' data-src='https://vidsrc.buzz.other.invalid/embed/movie/634649'></iframe>")]
  for(name,html)in rejected{do{_ = try StandaloneEmbedPlayer.resolve(html:html,pageURL:page);checks[name]=false}catch{checks[name]=true}}
  if let arg=CommandLine.arguments.dropFirst().first{let html=try String(contentsOfFile:arg,encoding:.utf8);checks["liveNoWayHomeEmbed"]=try StandaloneEmbedPlayer.resolve(html:html,pageURL:page).absoluteString==expected}
  let wrapper=URL(string:"https://streamsrcs.2embed.cc/swish?id=fixture123456&ref=https://www.2embed.cc/")!
  let swishPlayer=try StandaloneSwishPage.playerURL(wrapper:wrapper)
  checks["swishAdvertisedWrapper"]=swishPlayer.absoluteString=="https://2vcdn.skin/e/fixture123456"
  let packed = #"<script>eval(function(p,a,c,k,e,d){return p}('0 1={"2":"/3/4/5.6"};',36,7,'var|links|hls4|stream|default|master|m3u8'.split('|')))</script>"#
  checks["swishStaticStringTable"]=try StandaloneSwishPage.source(html:packed,player:swishPlayer).absoluteString=="https://2vcdn.skin/stream/default/master.m3u8"
  let badPacked=packed.replacingOccurrences(of:"/3/4/5.6",with:"https://other.invalid/3/4/5.6")
  do{_ = try StandaloneSwishPage.source(html:badPacked,player:swishPlayer);checks["swishRejectsUnknownPrimaryHost"]=false}catch{checks["swishRejectsUnknownPrimaryHost"]=true}
  do{_ = try StandaloneSwishPage.source(html:packed.replacingOccurrences(of:",36,7,",with:",36,8,"),player:swishPlayer);checks["swishMalformedTableRejected"]=false}catch{checks["swishMalformedTableRejected"]=true}
  do{_ = try StandaloneSwishPage.playerURL(wrapper:URL(string:"https://streamsrcs.2embed.cc/swish?id=../other")!);checks["swishInvalidIdentifierRejected"]=false}catch{checks["swishInvalidIdentifierRejected"]=true}
  if CommandLine.arguments.count > 3 {
   let current=try String(contentsOfFile:CommandLine.arguments[2],encoding:.utf8)
   let selected=try StandaloneEmbedPlayer.resolve(html:current,pageURL:page)
   checks["liveBrandNewDaySelectsDefaultSwish"]=selected.host=="streamsrcs.2embed.cc" && selected.path=="/swish"
   let live=try String(contentsOfFile:CommandLine.arguments[3],encoding:.utf8)
   let source=try StandaloneSwishPage.source(html:live,player:swishPlayer)
   checks["liveSwishPrimaryClearHLSAddress"]=source.host=="2vcdn.skin" && source.pathExtension=="m3u8"
  }
  print(String(decoding:try JSONSerialization.data(withJSONObject:checks,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self))
  guard checks.values.allSatisfy({$0}) else{throw NSError(domain:"EmbedChecks",code:1)}
 }
}
