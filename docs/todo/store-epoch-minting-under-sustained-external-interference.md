# Store-epoch minting under sustained external interference

**Status**: open. Raised by round 43's structural review, ruled out of scope by the owner's standing
ruling that this branch fixes existing defects rather than adding defenses.

Round 43 made both store-epoch writers survive a lost race with the reclaimer: `mintNextEpoch` retries
when its construction directory is observed absent, and `registerStoreEpochHolder` retries once at a
fresh uuid. Both arguments rest on the reclaimer taking **one** directory snapshot per run, so a sweep
that removes the first attempt's artifact cannot discover the second attempt's uuid.

That argument is true of every reclaimer this branch has, and production schedules one post-ready sweep
per coordinator startup. It is not true of an adversary outside the branch: something deleting store-root
entries continuously, or many post-ready sweeps invoked in parallel by hand, can starve minting
indefinitely and exhaust the holder's two attempts. Minting would spin, and the holder would refuse the
boot for a reason that is technically not a filesystem failure.

Closing that needs a fencing mechanism the branch does not have — the writer would need to hold something
the reclaimer must respect before its first artifact exists, which is the same pre-lock gap the
construction directory has. It is a new guarantee, not a repair, and it belongs to whoever decides the
store root needs to tolerate a hostile co-tenant.
