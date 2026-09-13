// Conexão do RicServ com o Supabase (banco de dados + login)
const SUPABASE_URL = 'https://karowddhtwailjefpnke.supabase.co';
const SUPABASE_KEY = 'sb_publishable_x694RYkncU0r0XKnblfEWQ_vYXCAJsJ';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
