cmake_minimum_required(VERSION 3.28)
project(micme_recognizer LANGUAGES C CXX)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "The optional Micme recognizer is currently supported on Linux only")
endif()

# Use the native subtree from the exact crate in Handy v0.10.2's Cargo.lock.
# Require a locally provisioned archive even at configure time.
set(TRANSCRIBE_ARCHIVE "" CACHE FILEPATH "Local transcribe-cpp-sys-0.4.2.crate")
set(archive_sha 32f94fb1e9a3033101bbd500d02993cfc95e315f24417038fd42f1fd80e1059a)
if(NOT EXISTS "${TRANSCRIBE_ARCHIVE}")
    message(FATAL_ERROR "Set TRANSCRIBE_ARCHIVE to the pinned local .crate (see README.md)")
endif()
file(SHA256 "${TRANSCRIBE_ARCHIVE}" actual_sha)
if(NOT actual_sha STREQUAL archive_sha)
    message(FATAL_ERROR "The transcribe archive does not match Handy's lock checksum")
endif()

set(extracted "${CMAKE_CURRENT_BINARY_DIR}/upstream")
set(upstream "${extracted}/transcribe-cpp-sys-0.4.2")
file(ARCHIVE_EXTRACT INPUT "${TRANSCRIBE_ARCHIVE}" DESTINATION "${extracted}")
include(instrument.cmake)

# CPU only. No upstream programs, plugins, external BLAS, OpenMP or downloads.
foreach(flag IN ITEMS BUILD_SHARED_LIBS TRANSCRIBE_BUILD_SHARED TRANSCRIBE_INSTALL
        TRANSCRIBE_BUILD_TESTS TRANSCRIBE_BUILD_REAL_MODEL_TESTS TRANSCRIBE_BUILD_EXAMPLES
        TRANSCRIBE_BUILD_TOOLS TRANSCRIBE_METAL TRANSCRIBE_VULKAN TRANSCRIBE_CUDA
        TRANSCRIBE_HIP TRANSCRIBE_USE_OPENMP TRANSCRIBE_USE_SYSTEM_BLAS
        TRANSCRIBE_ENABLE_VALIDATION_HOOKS TRANSCRIBE_GGML_BACKEND_DL
        GGML_NATIVE GGML_BACKEND_DL GGML_RPC GGML_BLAS GGML_OPENMP GGML_OPENMP_FETCH
        GGML_METAL GGML_VULKAN GGML_CUDA GGML_HIP GGML_CPU_KLEIDIAI)
    set(${flag} OFF CACHE BOOL "Disabled for the Micme CPU recognizer" FORCE)
endforeach()
# Fixed x86-64-v3-style SIMD choices rather than host autodetection. Arm64
# uses the compiler's baseline. Other architecture cells are not qualified.
set(TRANSCRIBE_X86_CONSERVATIVE ON CACHE BOOL "Use explicit ISA settings" FORCE)
if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64)$")
    foreach(flag IN ITEMS GGML_SSE42 GGML_AVX GGML_AVX2 GGML_BMI2 GGML_FMA GGML_F16C)
        set(${flag} ON CACHE BOOL "Required x86-64 CPU feature" FORCE)
    endforeach()
endif()
set(CMAKE_DISABLE_FIND_PACKAGE_Git ON)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang" AND CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    # Avoid build-directory paths in assertions and diagnostic strings.
    add_compile_options("-ffile-prefix-map=${CMAKE_CURRENT_BINARY_DIR}=micme-build"
        "-ffile-prefix-map=${CMAKE_CURRENT_SOURCE_DIR}=micme-recognizer")
endif()
add_subdirectory("${upstream}" "${CMAKE_CURRENT_BINARY_DIR}/transcribe" EXCLUDE_FROM_ALL)
# The upstream target's build interface assumes transcribe is the top-level project.
target_include_directories(transcribe PUBLIC "${upstream}/include")

add_executable(micme-recognizer main.cpp)
target_compile_features(micme-recognizer PRIVATE cxx_std_17)
set_target_properties(micme-recognizer PROPERTIES CXX_EXTENSIONS OFF)
target_link_libraries(micme-recognizer PRIVATE transcribe)
include(GNUInstallDirs)
install(TARGETS micme-recognizer RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../../LICENSE" DESTINATION "${CMAKE_INSTALL_DATADIR}/micme-recognizer" RENAME LICENSE.micme)
# The vendored llamafile SGEMM also carries a file-specific MIT notice.
file(STRINGS "${upstream}/ggml/src/ggml-cpu/llamafile/sgemm.cpp" sgemm_notice LIMIT_COUNT 21)
string(REPLACE ";" "\n" sgemm_notice "${sgemm_notice}")
string(REGEX REPLACE "(^|\n)// ?" "\\1" sgemm_notice "${sgemm_notice}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/LICENSE.llamafile" "${sgemm_notice}\n")
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/LICENSE.llamafile" DESTINATION "${CMAKE_INSTALL_DATADIR}/micme-recognizer")
foreach(component IN ITEMS transcribe ggml miniz silero_vad)
    if(component STREQUAL "transcribe")
        set(notice "${upstream}/LICENSE")
    elseif(component STREQUAL "ggml")
        set(notice "${upstream}/ggml/LICENSE")
    else()
        set(notice "${upstream}/src/third_party/${component}/LICENSE")
    endif()
    install(FILES "${notice}" DESTINATION "${CMAKE_INSTALL_DATADIR}/micme-recognizer" RENAME "LICENSE.${component}")
endforeach()
