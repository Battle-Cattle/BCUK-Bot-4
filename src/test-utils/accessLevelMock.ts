/** Shared mock mirroring the real `AccessLevel` values from `src/db/users.ts`, for use in `vi.mock('.../db/users', ...)` factories. */
export const ACCESS_LEVEL_MOCK = { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 } as const;
