// Inside server.js:
const MONGODB_URI = "mongodb+srv://wellbengalconsultancyservice_db_user:b3NoA15HaEhI8xtZ@ecommercecluster.fpe1bto.mongodb.net/fitscheck?compressors=zlib";

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));
