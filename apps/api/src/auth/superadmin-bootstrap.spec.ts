import bcrypt from 'bcryptjs';
import { provisionSuperadmin } from '../../scripts/bootstrap-superadmin';

describe('Superadmin bootstrap provisioning', () => {
  function client(existing: { id: string } | null = null) {
    return {
      superadminUser: {
        findUnique: jest.fn(async (_args: {
          where: { email: string };
          select: { id: true };
        }) => existing),
        create: jest.fn(async (_args: {
          data: { email: string; passwordHash: string; role: 'SUPERADMIN'; emailVerifiedAt: Date };
        }) => ({})),
      },
    };
  }

  it('creates the configured verified Superadmin with a bcrypt hash and required role', async () => {
    const prisma = client();
    const configuredEmail = await provisionSuperadmin(
      prisma,
      '  ADMIN@EXAMPLE.COM ',
      'true',
      'a sufficiently long secret',
    );
    const create = prisma.superadminUser.create.mock.calls[0][0];

    expect(configuredEmail).toBe('admin@example.com');
    expect(create.data.email).toBe('admin@example.com');
    expect(create.data.role).toBe('SUPERADMIN');
    expect(create.data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(create.data.passwordHash).not.toBe('a sufficiently long secret');
    await expect(bcrypt.compare('a sufficiently long secret', create.data.passwordHash)).resolves.toBe(true);
  });

  it('does not create or update an existing Superadmin', async () => {
    const prisma = client({ id: 'existing-admin' });

    await expect(provisionSuperadmin(prisma, 'admin@example.com', 'true', 'new password value'))
      .rejects.toThrow('this command never changes an existing account');
    expect(prisma.superadminUser.create).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'true', 'a sufficiently long secret'],
    ['not-an-email', 'true', 'a sufficiently long secret'],
    ['admin@example.com', 'false', 'a sufficiently long secret'],
    ['admin@example.com', 'true', 'short'],
    ['admin@example.com', 'true', 'a'.repeat(73)],
  ])('rejects invalid setup input without writing to the database', async (email, verified, password) => {
    const prisma = client();
    await expect(provisionSuperadmin(prisma, email, verified, password)).rejects.toThrow();
    expect(prisma.superadminUser.findUnique).not.toHaveBeenCalled();
    expect(prisma.superadminUser.create).not.toHaveBeenCalled();
  });
});
