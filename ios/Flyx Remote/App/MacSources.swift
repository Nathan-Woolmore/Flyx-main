import Foundation
struct MacSourceOperation:Encodable {let operation:String;var sourceID:String?}
struct MacSourceInventory:Decodable {let items:[MacSourceChoice]}
struct MacSourceChoice:Decodable,Identifiable {let id:String;let provider:String;let quality:String;let language:String;let format:String;let selected:Bool;var label:String{[provider,quality,language.uppercased()].filter{!$0.isEmpty}.joined(separator:" · ")}}
