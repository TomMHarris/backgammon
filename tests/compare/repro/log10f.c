/* log10f() is not correctly rounded in every C library. gnubg uses it in
   relativeFibsRating() (analysis.c:1371-1373) for the "luck based FIBS
   rating diff." statistic. This is the argument that occurs for
   tests/corpus/matches/match7 (1/r - 1 with r = 0.38791129f).

   Build and run natively and with Emscripten (see README.md next to this file). */
#include <stdio.h>
#include <math.h>
int main(void) {
    volatile float x = 1.577908992767334f;
    printf("%.17g\n", (double) log10f(x));
    return 0;
}
