#include "decoder.hpp"

#include <cstdio>
#include <cstring>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

int main(int argc, char **argv) {
#ifdef _WIN32
    // Protocol output uses LF even with the Windows CRT's text-mode default.
    if (_setmode(_fileno(stdout), _O_BINARY) == -1) {
        std::fputs("micme-live: could not set stdout to binary mode\n", stderr);
        return 1;
    }
#endif

    if (argc == 2 && std::strcmp(argv[1], "--protocol-version") == 0) {
        return std::fputs("1\n", stdout) == EOF || std::fflush(stdout) == EOF ? 1 : 0;
    }
    return run_live(argc, argv);
}
