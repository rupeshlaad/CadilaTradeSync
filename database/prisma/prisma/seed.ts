import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminPassword = await bcrypt.hash('Admin@123', 10);
  const userPassword = await bcrypt.hash('User@123', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'rupesh.laad@gmail.com' },
    update: {
      password: adminPassword,
      role: Role.ADMIN,
      isActive: true,
      name: 'Rupesh Laad',
    },
    create: {
      email: 'rupesh.laad@gmail.com',
      password: adminPassword,
      name: 'Rupesh Laad',
      role: Role.ADMIN,
    },
  });

  const user = await prisma.user.upsert({
    where: { email: 'user@cts.local' },
    update: {},
    create: {
      email: 'user@cts.local',
      password: userPassword,
      name: 'Demo User',
      role: Role.USER,
    },
  });

  console.log('Seeded users:');
  console.log(' - [rupesh.laad@gmail.com](mailto:rupesh.laad@gmail.com) / Admin@123');
  console.log(' - [user@cts.local](mailto:user@cts.local)  / User@123');
  console.log({ adminId: admin.id, userId: user.id });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });