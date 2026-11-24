#include "decoder.hpp"

#include <cstdio>

int run_live(int, char **) {
    std::fputs("{\"type\":\"error\",\"message\":\"Live decoding is not implemented in this build.\"}\n", stdout);
    std::fflush(stdout);
    return 1;
}
