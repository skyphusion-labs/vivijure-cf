### fix(finish): name photometric identity precondition

The 2% luma check is only valid for identity-preserving operations
(preset=neutral at strength 1, or strength 0). Named
SEMANTIC_PRECONDITION and returned as applies_when on
/photometric-check. Caller wiring is finish-blender after such a grade.
