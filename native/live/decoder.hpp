#pragma once

// Run the Worker v1 PCM/JSON-lines protocol. The launcher handles the version
// probe and puts stdout in binary mode; the decoder owns binary PCM stdin.
int run_live(int argc, char **argv);
