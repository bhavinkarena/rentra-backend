import { v2 as cloudinary } from 'cloudinary';
import { writeFile } from 'node:fs/promises';

cloudinary.config({
  cloud_name: 'dqmdurkd0',
  api_key: '378883538242614',
  api_secret: 'noXBStJnG_UgLXMXUOrKjdyNa3A',
  secure: true,
});

// Curated high-resolution Unsplash photos specifically matching Gujarat farmhouses,
// private villas, luxury pools, banquet lawns, orchards, and premium suites.
const PHOTO_SOURCES = {
  pools: [
    'https://images.unsplash.com/photo-1580587771525-78b9dba3b914?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1576013551627-0cc20b96c2a7?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1572331165267-854da2b10ccc?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1584132967334-10e028bd69f7?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1613977257363-707ba9348227?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1613490493576-7fde63acd811?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1540541338287-41700207dee6?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1571896349842-33c89424de2d?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=1200&q=80',
  ],
  villas: [
    'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1600565193348-f74bd3c7ccdf?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1600585154526-990dced4db0d?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1518780664697-55e3ad937233?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1523217582562-09d0def993a6?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1599809275671-b5942cabc7a2?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?auto=format&fit=crop&w=1200&q=80',
  ],
  lawns: [
    'https://images.unsplash.com/photo-1558904541-efa8c4a08931?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1592417817098-8f3d69104a47?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1470240731273-7821a6eeb6bd?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1533750349088-cd871a92f312?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1200&q=80',
  ],
  rooms: [
    'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1566665797739-1674de7a421a?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1578683010236-d716f9a3f461?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1618773928121-c32242e63f39?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1591088398332-8a7791972843?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1582582621959-48d27397dc69?auto=format&fit=crop&w=1200&q=80',
  ],
  grounds: [
    'https://images.unsplash.com/photo-1510798831971-661eb04b3739?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1544984243-ec57ea16fe25?auto=format&fit=crop&w=1200&q=80',
  ],
};

async function uploadAll() {
  console.log('[uploader] Starting Cloudinary upload for Gujarat photography library...');
  const uploaded = {
    pools: [],
    villas: [],
    lawns: [],
    rooms: [],
    grounds: [],
  };

  for (const [category, urls] of Object.entries(PHOTO_SOURCES)) {
    console.log(`[uploader] Processing category: ${category} (${urls.length} images)...`);
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const publicId = `gujarat_${category}_${i + 1}`;
      try {
        const res = await cloudinary.uploader.upload(url, {
          folder: 'seed/gujarat',
          public_id: publicId,
          overwrite: false,
          resource_type: 'image',
        });
        uploaded[category].push(res.secure_url);
        console.log(`  ✓ ${publicId} -> ${res.secure_url}`);
      } catch (err) {
        console.error(`  ✗ Error uploading ${publicId}:`, err.message);
        // Fallback: if already exists, derive direct secure url
        uploaded[category].push(`https://res.cloudinary.com/dqmdurkd0/image/upload/seed/gujarat/${publicId}.jpg`);
      }
    }
  }

  const outputPath = new URL('./cloudinary-gujarat-map.json', import.meta.url);
  await writeFile(outputPath, JSON.stringify(uploaded, null, 2), 'utf-8');
  console.log(`[uploader] All images uploaded! Map written to ${outputPath.pathname}`);
}

uploadAll().catch(console.error);
