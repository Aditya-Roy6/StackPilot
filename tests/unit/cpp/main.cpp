// Entry point for the C++ unit suite. Test bodies self-register via the
// TEST() macro in testing.h, so this only has to drive the runner.

#include "testing.h"

int main() {
    return stackpilot::testing::run();
}
