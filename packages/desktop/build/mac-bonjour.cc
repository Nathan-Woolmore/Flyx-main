// Native DNS-SD in the Electron main process. No subprocess or permission bypass.
#include <node_api.h>
#include <uv.h>
#include <dns_sd.h>
#include <arpa/inet.h>
#include <algorithm>
#include <cctype>
#include <memory>
#include <string>
#include <vector>

struct Scan;
struct Holder { Scan* scan = nullptr; bool cleanup = false; };
struct Service {
  Scan* scan;
  uint32_t interfaceIndex;
  std::string name, host, friendly, model, address;
  uint16_t port = 0;
  bool active = true;
  DNSServiceRef resolver = nullptr, addresses = nullptr;
};
struct Scan {
  napi_env env;
  napi_ref callback = nullptr;
  DNSServiceRef connection = nullptr, browser = nullptr;
  uv_poll_t poll{};
  Holder* holder;
  bool closed = false, polling = false;
  std::vector<std::unique_ptr<Service>> services;
};

static napi_value String(napi_env env, const std::string& text) {
  napi_value value; napi_create_string_utf8(env, text.c_str(), text.size(), &value); return value;
}
static void Set(napi_env env, napi_value object, const char* key, const std::string& text) {
  napi_set_named_property(env, object, key, String(env, text));
}
static void Number(napi_env env, napi_value object, const char* key, uint32_t number) {
  napi_value value; napi_create_uint32(env, number, &value); napi_set_named_property(env, object, key, value);
}
static napi_value Error(napi_env env, DNSServiceErrorType code) {
  const bool denied = code == kDNSServiceErr_PolicyDenied || code == kDNSServiceErr_NoAuth;
  napi_value value;
  napi_create_error(env, nullptr, String(env, denied ? "macOS denied Flyx local-network discovery access." : "Native Bonjour discovery failed."), &value);
  Set(env, value, "code", denied ? "EPERM" : "EDNSSD");
  napi_value number; napi_create_int32(env, code, &number); napi_set_named_property(env, value, "nativeCode", number);
  return value;
}
static void Notify(Scan* scan, napi_value error, napi_value service) {
  if (scan->closed) return;
  napi_value callback, receiver, result, arguments[] = {error, service};
  napi_get_reference_value(scan->env, scan->callback, &callback);
  napi_get_undefined(scan->env, &receiver);
  napi_call_function(scan->env, receiver, callback, 2, arguments, &result);
}
static void Fail(Scan* scan, DNSServiceErrorType code) {
  if (scan->closed) return;
  napi_value missing; napi_get_undefined(scan->env, &missing);
  Notify(scan, Error(scan->env, code), missing);
}
static void Emit(Service* service, bool removed) {
  Scan* scan = service->scan;
  if (scan->closed) return;
  napi_env env = scan->env;
  napi_value value, txt, addresses, nothing, flag;
  napi_create_object(env, &value); napi_create_object(env, &txt); napi_create_array(env, &addresses);
  Set(env, value, "name", service->name); Set(env, value, "host", service->host);
  Number(env, value, "interfaceIndex", service->interfaceIndex); Number(env, value, "port", service->port);
  napi_get_boolean(env, removed, &flag); napi_set_named_property(env, value, "removed", flag);
  if (!service->address.empty()) napi_set_element(env, addresses, 0, String(env, service->address));
  Set(env, txt, "fn", service->friendly.empty() ? service->name : service->friendly);
  Set(env, txt, "md", service->model);
  napi_set_named_property(env, value, "txt", txt); napi_set_named_property(env, value, "addresses", addresses);
  napi_get_null(env, &nothing); Notify(scan, nothing, value);
}
static bool Denied(DNSServiceErrorType code) { return code == kDNSServiceErr_PolicyDenied || code == kDNSServiceErr_NoAuth; }
static void AddressReply(DNSServiceRef, DNSServiceFlags flags, uint32_t, DNSServiceErrorType error,
                         const char*, const sockaddr* address, uint32_t, void* context) {
  Service* service = static_cast<Service*>(context);
  if (service->scan->closed || !service->active) return;
  if (error) { if (Denied(error)) Fail(service->scan, error); return; }
  if (!address || address->sa_family != AF_INET) return;
  char text[INET_ADDRSTRLEN];
  const auto* ipv4 = reinterpret_cast<const sockaddr_in*>(address);
  if (!inet_ntop(AF_INET, &ipv4->sin_addr, text, sizeof(text))) return;
  if (!(flags & kDNSServiceFlagsAdd)) {
    if (service->address == text) { Emit(service, true); service->address.clear(); }
    return;
  }
  service->address = text; Emit(service, false);
}
static std::string Txt(uint16_t length, const unsigned char* data, const char* key) {
  uint8_t size = 0;
  const void* value = TXTRecordGetValuePtr(length, data, key, &size);
  return value ? std::string(static_cast<const char*>(value), std::min<size_t>(size, 120)) : "";
}
static void ResolveReply(DNSServiceRef, DNSServiceFlags, uint32_t interfaceIndex, DNSServiceErrorType error,
                         const char*, const char* host, uint16_t port, uint16_t txtLength,
                         const unsigned char* txt, void* context) {
  Service* service = static_cast<Service*>(context); Scan* scan = service->scan;
  if (scan->closed || !service->active) return;
  if (error) { if (Denied(error)) Fail(scan, error); return; }
  service->port = ntohs(port);
  if (service->port != 8009 || !host) return;
  service->host = host;
  std::string normalized = service->host;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), ::tolower);
  if (normalized.size() < 7 || normalized.compare(normalized.size() - 7, 7, ".local.") != 0) return;
  service->friendly = Txt(txtLength, txt, "fn"); service->model = Txt(txtLength, txt, "md");
  if (service->addresses) { if (!service->address.empty()) Emit(service, false); return; }
  service->addresses = scan->connection;
  const auto result = DNSServiceGetAddrInfo(&service->addresses, kDNSServiceFlagsShareConnection,
    interfaceIndex, kDNSServiceProtocol_IPv4, host, AddressReply, service);
  if (result) { service->addresses = nullptr; if (Denied(result)) Fail(scan, result); }
}
static void BrowseReply(DNSServiceRef, DNSServiceFlags flags, uint32_t interfaceIndex, DNSServiceErrorType error,
                        const char* name, const char* type, const char* domain, void* context) {
  Scan* scan = static_cast<Scan*>(context);
  if (scan->closed) return;
  if (error) { Fail(scan, error); return; }
  auto existing = std::find_if(scan->services.begin(), scan->services.end(), [&](const auto& service) {
    return service->name == name && service->interfaceIndex == interfaceIndex && service->active;
  });
  if (!(flags & kDNSServiceFlagsAdd)) {
    if (existing != scan->services.end()) { (*existing)->active = false; Emit(existing->get(), true); }
    return;
  }
  if (existing != scan->services.end() || scan->services.size() >= 64) return;
  auto service = std::make_unique<Service>(); service->scan = scan; service->interfaceIndex = interfaceIndex; service->name = name;
  Service* pointer = service.get(); scan->services.push_back(std::move(service));
  pointer->resolver = scan->connection;
  const auto result = DNSServiceResolve(&pointer->resolver, kDNSServiceFlagsShareConnection,
    interfaceIndex, name, type, domain, ResolveReply, pointer);
  if (result) { pointer->resolver = nullptr; if (Denied(result)) Fail(scan, result); }
}
static void Release(Scan* scan) {
  for (auto& service : scan->services) {
    if (service->addresses) DNSServiceRefDeallocate(service->addresses);
    if (service->resolver) DNSServiceRefDeallocate(service->resolver);
  }
  if (scan->browser) DNSServiceRefDeallocate(scan->browser);
  if (scan->connection) DNSServiceRefDeallocate(scan->connection);
  delete scan;
}
static void Stop(Holder* holder) {
  Scan* scan = holder->scan;
  if (!scan) return;
  holder->scan = nullptr; scan->closed = true;
  if (scan->polling) uv_poll_stop(&scan->poll);
  if (scan->callback) napi_delete_reference(scan->env, scan->callback);
  // A JS error handler may close the search inside DNSServiceProcessResult.
  // Deallocate native refs after that callback stack has unwound.
  if (scan->polling) uv_close(reinterpret_cast<uv_handle_t*>(&scan->poll), [](uv_handle_t* handle) { Release(static_cast<Scan*>(handle->data)); });
  else Release(scan);
}
static void Cleanup(void* data) { auto* holder = static_cast<Holder*>(data); holder->cleanup = false; Stop(holder); }
static void Finalize(napi_env env, void* data, void*) {
  auto* holder = static_cast<Holder*>(data);
  if (holder->cleanup) napi_remove_env_cleanup_hook(env, Cleanup, holder);
  Stop(holder); delete holder;
}
static napi_value Close(napi_env env, napi_callback_info info) {
  napi_value self; napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr);
  Holder* holder = nullptr; napi_unwrap(env, self, reinterpret_cast<void**>(&holder));
  if (holder) Stop(holder);
  napi_value nothing; napi_get_undefined(env, &nothing); return nothing;
}
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value callback; napi_get_cb_info(env, info, &count, &callback, nullptr, nullptr);
  napi_valuetype type; if (!count || napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Bonjour callback is required."); return nullptr;
  }
  auto* holder = new Holder(); auto* scan = new Scan(); holder->scan = scan; scan->holder = holder; scan->env = env;
  napi_create_reference(env, callback, 1, &scan->callback);
  auto result = DNSServiceCreateConnection(&scan->connection);
  if (!result) {
    scan->browser = scan->connection;
    result = DNSServiceBrowse(&scan->browser, kDNSServiceFlagsShareConnection, 0, "_googlecast._tcp", "local.", BrowseReply, scan);
    if (result) scan->browser = nullptr;
  }
  if (result) { napi_value error = Error(env, result); Stop(holder); delete holder; napi_throw(env, error); return nullptr; }
  uv_loop_t* loop = nullptr; napi_get_uv_event_loop(env, &loop);
  int status = uv_poll_init_socket(loop, &scan->poll, DNSServiceRefSockFD(scan->connection));
  if (!status) {
    scan->polling = true; scan->poll.data = scan;
    status = uv_poll_start(&scan->poll, UV_READABLE, [](uv_poll_t* handle, int status, int) {
      auto* scan = static_cast<Scan*>(handle->data); if (scan->closed) return;
      napi_handle_scope scope; napi_open_handle_scope(scan->env, &scope);
      if (status < 0) Fail(scan, kDNSServiceErr_Unknown);
      else { const auto error = DNSServiceProcessResult(scan->connection); if (error && !scan->closed) Fail(scan, error); }
      napi_close_handle_scope(scan->env, scope);
    });
  }
  if (status) { Stop(holder); delete holder; napi_throw_error(env, nullptr, "Could not monitor native Bonjour."); return nullptr; }
  napi_value handle, stop; napi_create_object(env, &handle); napi_wrap(env, handle, holder, Finalize, nullptr, nullptr);
  napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Close, nullptr, &stop); napi_set_named_property(env, handle, "stop", stop);
  holder->cleanup = true; napi_add_env_cleanup_hook(env, Cleanup, holder);
  return handle;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value start; napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &start);
  napi_set_named_property(env, exports, "start", start); return exports;
}
NAPI_MODULE(flyx_bonjour, Init)
