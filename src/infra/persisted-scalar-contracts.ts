import { z } from 'zod';

export const persistedNonEmptyStringSchema = z.string().min(1);
