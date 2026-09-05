#include <windows.h>

#include <cstdio>
#include <cwchar>
#include <string>

namespace {

std::wstring userRoot() {
    wchar_t value[MAX_PATH];
    const DWORD length = GetEnvironmentVariableW(L"USERPROFILE", value, MAX_PATH);
    return length > 0 && length < MAX_PATH ? std::wstring(value, length) : L"";
}

std::wstring profileDirectory(const std::wstring& profile) {
    return userRoot() + L"\\.openmausbot\\antigravity-profiles\\worker-" + profile;
}

bool validProfile(const std::wstring& profile) {
    return profile == L"a" || profile == L"b";
}

bool directoryExists(const std::wstring& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

bool writeActiveProfile(const std::wstring& profile) {
    const std::wstring root = userRoot() + L"\\.openmausbot";
    CreateDirectoryW(root.c_str(), nullptr);
    const std::wstring temporary = root + L"\\active-antigravity-profile.tmp";
    const std::wstring target = root + L"\\active-antigravity-profile";
    HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_HIDDEN, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    const char byte = profile == L"a" ? 'a' : 'b';
    DWORD written = 0;
    const bool wrote = WriteFile(file, &byte, 1, &written, nullptr) && written == 1;
    CloseHandle(file);
    if (!wrote) {
        DeleteFileW(temporary.c_str());
        return false;
    }
    return MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
}

std::wstring readActiveProfile() {
    const std::wstring path = userRoot() + L"\\.openmausbot\\active-antigravity-profile";
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return L"";
    char bytes[8] = {};
    DWORD read = 0;
    ReadFile(file, bytes, sizeof(bytes) - 1, &read, nullptr);
    CloseHandle(file);
    if (read == 1 && (bytes[0] == 'a' || bytes[0] == 'b')) return std::wstring(1, static_cast<wchar_t>(bytes[0]));
    return L"";
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wcscmp(argv[1], L"--version") == 0) {
        std::wprintf(L"OpenMaus Antigravity account vault 1.0.0-local\n");
        return 0;
    }
    if (argc == 2 && std::wcscmp(argv[1], L"which") == 0) {
        const std::wstring active = readActiveProfile();
        if (!active.empty()) std::wprintf(L"%ls\n", active.c_str());
        return 0;
    }
    if (argc == 3 && std::wcscmp(argv[1], L"exists") == 0) {
        return validProfile(argv[2]) && directoryExists(profileDirectory(argv[2])) ? 0 : 1;
    }
    if (argc == 3 && std::wcscmp(argv[1], L"activate") == 0) {
        return validProfile(argv[2]) && directoryExists(profileDirectory(argv[2])) && writeActiveProfile(argv[2]) ? 0 : 1;
    }
    if (argc == 2 && std::wcscmp(argv[1], L"capture") == 0) return 0;
    return 2;
}
