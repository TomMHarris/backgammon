/* gnubg's CompareMoves (eval.c:2811-2816) on 8 moves with identical scores:
   it never returns 0, so the final order of equal elements is whatever the
   C library's qsort algorithm produces. */
#include <stdio.h>
#include <stdlib.h>
typedef struct { int id; float rScore, rScore2; } move;
static int CompareMoves(const void *a, const void *b) {
    const move *pm0 = a, *pm1 = b;
    return (pm1->rScore > pm0->rScore || (pm1->rScore == pm0->rScore && pm1->rScore2 > pm0->rScore2)) ? 1 : -1;
}
int main(void) {
    move m[8];
    for (int i = 0; i < 8; i++) { m[i].id = i; m[i].rScore = -1.0f; m[i].rScore2 = -1.0f; }
    qsort(m, 8, sizeof(move), CompareMoves);
    for (int i = 0; i < 8; i++) printf("%d ", m[i].id);
    printf("\n");
    return 0;
}
