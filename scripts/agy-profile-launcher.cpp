#define UNICODE
#define _UNICODE
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cwchar>
#include <cstdio>
#include <string>
#include <vector>

#ifndef PROFILE_NAME
#error PROFILE_NAME must be defined at compile time
#endif

static std::wstring quote(const std::wstring& value) {
    if (value.find_first_of(L" \t\"") == std::wstring::npos) return value;
    std::wstring out = L"\"";
    unsigned backslashes = 0;
    for (wchar_t ch : value) {
        if (ch == L'\\') {
            ++backslashes;
        } else if (ch == L'\"') {
            out.append(backslashes * 2 + 1, L'\\');
            out.push_back(L'\"');
            backslashes = 0;
        } else {
            out.append(backslashes, L'\\');
            backslashes = 0;
            out.push_back(ch);
        }
    }
    out.append(backslashes * 2, L'\\');
    out.push_back(L'\"');
    return out;
}

enum class AgyPatchStatus {
    Patched,
    Unpatched,
    Unknown,
};

static AgyPatchStatus inspectAgyPatch(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return AgyPatchStatus::Unknown;

    LARGE_INTEGER length{};
    if (!GetFileSizeEx(file, &length) || length.QuadPart < 19 ||
        static_cast<unsigned long long>(length.QuadPart) > SIZE_MAX) {
        CloseHandle(file);
        return AgyPatchStatus::Unknown;
    }

    HANDLE mapping = CreateFileMappingW(file, nullptr, PAGE_READONLY, 0, 0, nullptr);
    if (!mapping) {
        CloseHandle(file);
        return AgyPatchStatus::Unknown;
    }
    const auto* data = static_cast<const std::uint8_t*>(
        MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0));
    if (!data) {
        CloseHandle(mapping);
        CloseHandle(file);
        return AgyPatchStatus::Unknown;
    }

    const size_t size = static_cast<size_t>(length.QuadPart);
    unsigned patched = 0;
    unsigned unpatched = 0;
    for (size_t i = 0; i + 19 <= size; ++i) {
        if (data[i] != 0x48 || data[i + 1] != 0x85 || data[i + 2] != 0xc0 ||
            data[i + 3] != 0x0f || data[i + 4] != 0x84 ||
            data[i + 13] != 0x0f || data[i + 14] != 0x85) {
            continue;
        }
        if (data[i + 9] == 0x80 && data[i + 10] == 0x78 &&
            data[i + 11] == 0x08 && data[i + 12] == 0x00) {
            ++unpatched;
        } else if (data[i + 9] == 0x48 && data[i + 10] == 0x85 &&
                   data[i + 11] == 0xc0 && data[i + 12] == 0x90) {
            ++patched;
        }
    }

    UnmapViewOfFile(data);
    CloseHandle(mapping);
    CloseHandle(file);
    if (unpatched > 0) return AgyPatchStatus::Unpatched;
    if (patched > 0) return AgyPatchStatus::Patched;
    return AgyPatchStatus::Unknown;
}

static DWORD runProcess(const std::wstring& executable, const std::wstring& command,
                        bool inheritHandles, DWORD creationFlags) {
    std::vector<wchar_t> mutableCommand(command.begin(), command.end());
    mutableCommand.push_back(L'\0');
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), mutableCommand.data(), nullptr, nullptr,
                        inheritHandles ? TRUE : FALSE, creationFlags, nullptr, nullptr,
                        &startup, &process)) {
        return GetLastError();
    }
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exitCode = 1;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hProcess);
    return exitCode;
}

static const wchar_t* profileCode() {
    return std::wcscmp(PROFILE_NAME, L"worker-a") == 0 ? L"a" : L"b";
}

static DWORD runVault(const std::wstring& vault, const wchar_t* action) {
    const std::wstring command = std::wcscmp(action, L"capture") == 0
        ? quote(vault) + L" capture"
        : quote(vault) + L" " + action + L" " + profileCode();
    return runProcess(vault, command, false, CREATE_NO_WINDOW);
}

static void clearProxyEnvironment() {
    const wchar_t* names[] = {
        L"HTTP_PROXY", L"HTTPS_PROXY", L"ALL_PROXY", L"NO_PROXY",
        L"http_proxy", L"https_proxy", L"all_proxy", L"no_proxy",
    };
    for (const wchar_t* name : names) SetEnvironmentVariableW(name, nullptr);
}

enum class NetworkRouteMode {
    System,
    Proxy,
};

struct NetworkRoute {
    NetworkRouteMode mode;
    std::wstring proxy;
};

static std::wstring environmentValue(const wchar_t* name) {
    DWORD capacity = 256;
    for (;;) {
        std::vector<wchar_t> buffer(capacity);
        const DWORD copied = GetEnvironmentVariableW(name, buffer.data(), capacity);
        if (copied == 0) return L"";
        if (copied < capacity - 1) return std::wstring(buffer.data(), copied);
        if (capacity > 32768) return L"";
        capacity = copied + 1;
    }
}

static bool normalizeLoopbackProxyUrl(const std::wstring& input, std::wstring* normalized) {
    if (input.empty()) return false;
    for (const wchar_t ch : input) {
        if (ch <= L' ' || ch == L'\x7f') return false;
    }

    const size_t schemeEnd = input.find(L"://");
    if (schemeEnd == std::wstring::npos) return false;
    std::wstring scheme = input.substr(0, schemeEnd);
    std::transform(scheme.begin(), scheme.end(), scheme.begin(), towlower);
    if (scheme != L"http" && scheme != L"https") return false;

    const size_t authorityStart = schemeEnd + 3;
    const std::wstring authority = input.substr(authorityStart);
    if (authority.empty() || authority.find_first_of(L"/@?#") != std::wstring::npos) return false;

    const size_t portSeparator = authority.rfind(L':');
    if (portSeparator == std::wstring::npos || portSeparator == 0 ||
        portSeparator + 1 >= authority.size()) {
        return false;
    }
    std::wstring host = authority.substr(0, portSeparator);
    const std::wstring portText = authority.substr(portSeparator + 1);
    std::transform(host.begin(), host.end(), host.begin(), towlower);
    if (host != L"127.0.0.1" && host != L"localhost" && host != L"[::1]") return false;

    unsigned long long port = 0;
    for (const wchar_t ch : portText) {
        if (ch < L'0' || ch > L'9') return false;
        port = port * 10 + static_cast<unsigned long long>(ch - L'0');
        if (port > 65535) return false;
    }
    if (port == 0) return false;

    *normalized = scheme + L"://" + host + L":" + std::to_wstring(port);
    return true;
}

static NetworkRoute readNetworkRoute() {
    const std::wstring signal = environmentValue(L"OPENMAUSBOT_ANTIGRAVITY_NETWORK_ROUTE");
    constexpr wchar_t proxyPrefix[] = L"proxy|";
    if (signal.rfind(proxyPrefix, 0) == 0) {
        std::wstring proxy;
        if (normalizeLoopbackProxyUrl(signal.substr(sizeof(proxyPrefix) / sizeof(*proxyPrefix) - 1), &proxy)) {
            return {NetworkRouteMode::Proxy, proxy};
        }
    }
    return {NetworkRouteMode::System, L""};
}

static void clearOwnedProxyGodebug() {
    const std::wstring current = environmentValue(L"GODEBUG");
    if (current.empty()) {
        SetEnvironmentVariableW(L"GODEBUG", nullptr);
        return;
    }

    std::wstring kept;
    size_t start = 0;
    while (start <= current.size()) {
        const size_t end = current.find(L',', start);
        const size_t length = end == std::wstring::npos ? current.size() - start : end - start;
        std::wstring segment = current.substr(start, length);
        while (!segment.empty() && (segment.front() == L' ' || segment.front() == L'\t')) segment.erase(0, 1);
        while (!segment.empty() && (segment.back() == L' ' || segment.back() == L'\t')) segment.pop_back();
        if (!segment.empty() && segment != L"http2client=0") {
            if (!kept.empty()) kept.push_back(L',');
            kept += segment;
        }
        if (end == std::wstring::npos) break;
        start = end + 1;
    }

    SetEnvironmentVariableW(L"GODEBUG", kept.empty() ? nullptr : kept.c_str());
}

static NetworkRoute configureNetworkRoute() {
    const NetworkRoute route = readNetworkRoute();
    if (route.mode == NetworkRouteMode::Proxy) {
        clearProxyEnvironment();
        const wchar_t* proxy = route.proxy.c_str();
        const wchar_t* noProxy = L"localhost,127.0.0.1,::1";
        SetEnvironmentVariableW(L"HTTP_PROXY", proxy);
        SetEnvironmentVariableW(L"HTTPS_PROXY", proxy);
        SetEnvironmentVariableW(L"ALL_PROXY", proxy);
        SetEnvironmentVariableW(L"NO_PROXY", noProxy);
        SetEnvironmentVariableW(L"http_proxy", proxy);
        SetEnvironmentVariableW(L"https_proxy", proxy);
        SetEnvironmentVariableW(L"all_proxy", proxy);
        SetEnvironmentVariableW(L"no_proxy", noProxy);
        SetEnvironmentVariableW(L"GODEBUG", L"http2client=0");
        return route;
    }

    // Missing, unknown, and invalid signals deliberately use ordinary Windows
    // routing (including any active system/TUN route). Never infer a proxy.
    clearProxyEnvironment();
    clearOwnedProxyGodebug();
    return route;
}

static const wchar_t* routeModeName(NetworkRouteMode mode) {
    return mode == NetworkRouteMode::Proxy ? L"proxy" : L"system";
}

static void printRouteEnvironment(const NetworkRoute& route) {
    wprintf(L"route=%ls\n", routeModeName(route.mode));
    if (route.mode == NetworkRouteMode::Proxy) wprintf(L"proxy=%ls\n", route.proxy.c_str());
    const wchar_t* names[] = {
        L"HTTP_PROXY", L"HTTPS_PROXY", L"ALL_PROXY", L"NO_PROXY",
        L"http_proxy", L"https_proxy", L"all_proxy", L"no_proxy", L"GODEBUG",
    };
    for (const wchar_t* name : names) {
        const std::wstring value = environmentValue(name);
        wprintf(L"%ls=%ls\n", name, value.empty() ? L"<absent>" : value.c_str());
    }
}

int wmain(int argc, wchar_t** argv) {
    // Disable agy's self-update before any diagnostic, route, credential, or
    // provider work. The launcher owns the patched master lifecycle.
    SetEnvironmentVariableW(L"AGY_CLI_DISABLE_AUTO_UPDATE", L"true");

    if (argc == 2 && std::wcscmp(argv[1], L"--openmaus-inspect-route") == 0) {
        const NetworkRoute route = configureNetworkRoute();
        printRouteEnvironment(route);
        return 0;
    }

    wchar_t userProfile[MAX_PATH];
    DWORD size = GetEnvironmentVariableW(L"USERPROFILE", userProfile, MAX_PATH);
    if (size == 0 || size >= MAX_PATH) return 110;

    std::wstring profile = std::wstring(userProfile) +
        L"\\.openmausbot\\antigravity-profiles\\" + PROFILE_NAME;
    CreateDirectoryW((std::wstring(userProfile) + L"\\.openmausbot").c_str(), nullptr);
    CreateDirectoryW((std::wstring(userProfile) + L"\\.openmausbot\\antigravity-profiles").c_str(), nullptr);
    CreateDirectoryW(profile.c_str(), nullptr);

    // Deterministic regression hook: classify an arbitrary fixture without
    // touching route or credential state. The normal launcher never supplies
    // this private diagnostic argument.
    if (argc == 3 && std::wcscmp(argv[1], L"--openmaus-inspect-patch") == 0) {
        const AgyPatchStatus status = inspectAgyPatch(argv[2]);
        wprintf(L"%ls\n",
                status == AgyPatchStatus::Patched ? L"patched" :
                status == AgyPatchStatus::Unpatched ? L"unpatched" : L"unknown");
        return status == AgyPatchStatus::Patched ? 0 :
               status == AgyPatchStatus::Unpatched ? 115 : 116;
    }

    SetEnvironmentVariableW(L"USERPROFILE", profile.c_str());
    SetEnvironmentVariableW(L"HOME", profile.c_str());
    const NetworkRoute networkRoute = configureNetworkRoute();

    // Never execute the mutable upstream installation. agy's background
    // updater can replace or remove that path after a successful request.
    // OpenMaus instead executes one read-only patched master. Provider calls
    // are serialized by the credential mutex, while concurrent --version
    // probes are read-only and therefore cannot race on a copied runtime file.
    const std::wstring pinnedAgy = std::wstring(userProfile) +
        L"\\.openmausbot\\bin\\agy-pinned.exe";
    const std::wstring agy = pinnedAgy;

    const AgyPatchStatus pinnedPatchStatus = inspectAgyPatch(pinnedAgy);
    if (pinnedPatchStatus != AgyPatchStatus::Patched) {
        fwprintf(stderr,
            L"OpenMaus pinned agy master is missing or not patched; explicit repair is required. "
            L"agy was not started.\n");
        return 117;
    }
    SetFileAttributesW(pinnedAgy.c_str(), FILE_ATTRIBUTE_READONLY);

    const AgyPatchStatus patchStatus = inspectAgyPatch(agy);
    if (argc == 2 && std::wcscmp(argv[1], L"--openmaus-diagnose") == 0) {
        wprintf(L"profile=%ls\nroot=%ls\nagy=%ls\npatch=%ls\nroute=%ls%s%ls\n",
                PROFILE_NAME, profile.c_str(), agy.c_str(),
                patchStatus == AgyPatchStatus::Patched ? L"patched" :
                patchStatus == AgyPatchStatus::Unpatched ? L"unpatched" : L"unknown",
                routeModeName(networkRoute.mode),
                networkRoute.mode == NetworkRouteMode::Proxy ? L":" : L"",
                networkRoute.mode == NetworkRouteMode::Proxy ? networkRoute.proxy.c_str() : L"");
        return patchStatus == AgyPatchStatus::Unpatched ? 115 : 0;
    }
    if (patchStatus == AgyPatchStatus::Unpatched) {
        fwprintf(stderr,
            L"agy binary is unpatched after an update; restore the verified eligibility patch. "
            L"agy was not started.\n");
        return 115;
    }

    // Version discovery is read-only and must not wait behind a live worker's
    // activate -> agy -> capture credential transaction. OpenMaus probes this
    // while rendering the model picker; taking the credential mutex here made
    // an installed, working wrapper look absent whenever that profile was busy.
    if (argc == 2 && std::wcscmp(argv[1], L"--version") == 0) {
        const std::wstring command = quote(agy) + L" --version";
        return static_cast<int>(runProcess(agy, command, true, 0));
    }

    std::wstring vault = environmentValue(L"OMB_ANTIGRAVITY_VAULT");
    if (vault.empty()) {
        const std::wstring resources = environmentValue(L"OMB_RESOURCES_PATH");
        vault = resources.empty()
            ? std::wstring(userProfile) + L"\\.openmausbot\\bin\\agy-account-vault.exe"
            : resources + L"\\antigravity\\agy-account-vault.exe";
    }
    HANDLE credentialMutex = CreateMutexW(
        nullptr, FALSE, L"Local\\OpenMausBot.AntigravityCredential");
    if (!credentialMutex) return 113;
    const DWORD mutexWait = WaitForSingleObject(credentialMutex, INFINITE);
    if (mutexWait != WAIT_OBJECT_0 && mutexWait != WAIT_ABANDONED) {
        CloseHandle(credentialMutex);
        return 113;
    }
    // The vault is global and resolves its root from USERPROFILE. Switch back
    // for vault I/O, then restore the isolated profile before starting agy.
    SetEnvironmentVariableW(L"USERPROFILE", userProfile);
    const DWORD activateExit = runVault(vault, L"activate");
    SetEnvironmentVariableW(L"USERPROFILE", profile.c_str());
    if (activateExit != 0) {
        fwprintf(stderr, L"Could not activate isolated Antigravity profile %ls.\n", PROFILE_NAME);
        ReleaseMutex(credentialMutex);
        CloseHandle(credentialMutex);
        return 113;
    }

    std::wstring command = quote(agy);
    for (int i = 1; i < argc; ++i) {
        command.push_back(L' ');
        command += quote(argv[i]);
    }
    const DWORD exitCode = runProcess(agy, command, true, 0);
    SetEnvironmentVariableW(L"USERPROFILE", userProfile);
    const DWORD captureExit = runVault(vault, L"capture");
    ReleaseMutex(credentialMutex);
    CloseHandle(credentialMutex);
    if (captureExit != 0) {
        fwprintf(stderr, L"Could not persist refreshed Antigravity profile %ls.\n", PROFILE_NAME);
        return 114;
    }
    return static_cast<int>(exitCode);
}
