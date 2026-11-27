# Count actual decoder invocations, not feed calls, changed text or timings.
# These are the decoder entry points for all supported routes in this build:
# Moonshine streamer + comparator and Parakeet TDT whole-file/chunked batch.
# Never expand the adapter's allowlist without instrumenting the new path.
function(instrument relative source_anchor)
    set(path "${upstream}/src/arch/${relative}/model.cpp")
    file(READ "${path}" source)
    string(FIND "${source}" "${source_anchor}" first)
    string(FIND "${source}" "${source_anchor}" last REVERSE)
    if(first LESS 0 OR NOT first EQUAL last)
        message(FATAL_ERROR "Cannot uniquely locate ${relative} decoder entry")
    endif()
    string(REPLACE "${source_anchor}" "    micme_asr_call();\n${source_anchor}" source "${source}")
    file(WRITE "${path}" "extern \"C\" void micme_asr_call();\n${source}")
endfunction()
instrument(moonshine_streaming "    const int64_t t_decode_start = ggml_time_us();")
instrument(parakeet "    pc->raw_tokens.clear();\n    const int64_t t_dec_start = ggml_time_us();\n    {\n        transcribe_status st = TRANSCRIBE_OK;")
