**Fix: plan-enhance keeps a shot under the 50 word cap (#1150).**

A rewrite over the cap was returned as success and then refused by the validator. The model is now asked for under 40 words. A rewrite still over 50 keeps the original prompt, and the notes say how many.
