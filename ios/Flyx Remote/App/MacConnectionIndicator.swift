import SwiftUI

/// Read-only status, with a checkmark or explicit disconnected text in addition to colour.
struct MacConnectionIndicator:View {
    let client:RemoteClient
    @State private var connected=true
    private struct Ping:Decodable{let deviceID:String}
    var body:some View {
        Group {
            if connected {
                Image(systemName:"desktopcomputer").font(.caption).foregroundStyle(.secondary)
                    .overlay(alignment:.bottomTrailing){Image(systemName:"checkmark.circle.fill").font(.system(size:8,weight:.bold)).foregroundStyle(.green).background(.black,in:.circle).offset(x:4,y:2)}
            }else{Label("Disconnected",systemImage:"wifi.slash").font(.caption).foregroundStyle(.orange)}
        }.padding(.horizontal,8).padding(.vertical,6)
            .accessibilityElement(children:.ignore)
            .accessibilityLabel(connected ? "Connected to Mac":"Disconnected from Mac")
            .accessibilityHint("Connection status. Choose playback output in the Remote tab.")
            .task{
                while !Task.isCancelled {
                    do{let _:Ping=try await client.request("/remote/v1/session");connected=true}
                    catch is CancellationError{return}
                    catch{if !Task.isCancelled{connected=false}}
                    do{try await Task.sleep(for:.seconds(15))}catch{return}
                }
            }
    }
}
