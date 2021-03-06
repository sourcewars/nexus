export type TestContext = {
  user: User | null;
};

export interface User {
  firstName: string;
  lastName: string;
  email: string;
  fullName(): string;
}
