cmake_minimum_required(VERSION 3.28)
project(micme_live LANGUAGES C CXX)

# Build out of tree (for example, -B build/micme-live). The only installed
# product is the worker; upstream sources and libraries are build inputs.
include(FetchContent)
include(GNUInstallDirs)

set(whispercpp_revision 96ec4d9823e9d0211944172da35f9f29134af990) # v1.9.6

# Link the pinned whisper.cpp and ggml statically. Omit tools, network
# facilities, and every upstream example (in particular the SDL recorder).
foreach(flag IN ITEMS BUILD_SHARED_LIBS WHISPER_BUILD_TESTS WHISPER_BUILD_EXAMPLES
        WHISPER_BUILD_SERVER WHISPER_SDL2 WHISPER_CURL WHISPER_USE_SYSTEM_GGML
        WHISPER_USE_SYSTEM_LLAMA GGML_BACKEND_DL GGML_RPC GGML_OPENMP_FETCH)
    set(${flag} OFF CACHE BOOL "Disabled in the micme-live build" FORCE)
endforeach()
option(GGML_METAL "Build the optional Metal backend" OFF)

# Use pin metadata, not Git discovery that could identify the enclosing Micme
# checkout instead of the upstream source archive.
set(CMAKE_DISABLE_FIND_PACKAGE_Git ON)
set(GIT_EXECUTABLE "")
set(GIT_EXE "")
set(WHISPER_BUILD_COMMIT "${whispercpp_revision}")
set(GGML_BUILD_COMMIT "${whispercpp_revision}")

# For an offline setup, set FETCHCONTENT_SOURCE_DIR_WHISPERCPP to a trusted
# local source tree at the same revision (this bypasses download and hashing).
FetchContent_Declare(whispercpp
    URL "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${whispercpp_revision}"
    URL_HASH SHA256=4d46e659151f31535b3947e322a58b0c604d3cbe93dfb284294e989a19d25ad7
    TLS_VERIFY ON
    EXCLUDE_FROM_ALL
)
FetchContent_MakeAvailable(whispercpp)

# Keep the launcher/probe in main.cpp and put decoder implementation in
# decoder.cpp/.hpp. Add any new build inputs explicitly to the package list
# and package guard; do not publish the build tree.
add_executable(micme-live main.cpp decoder.cpp decoder.hpp)
target_compile_features(micme-live PRIVATE cxx_std_17)
set_target_properties(micme-live PROPERTIES CXX_EXTENSIONS OFF)
target_link_libraries(micme-live PRIVATE whisper)
install(TARGETS micme-live RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")
