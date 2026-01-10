        //oz@microchip.cl 
        //@Emmet53279!
const axios = require('axios');

// ==========================================
// ⚙️ CONFIGURACIÓN DEL ROBOT
// ==========================================
const CONFIG = {
    // 1. EL RUT DE TU EMPRESA (Microchip)
    // Pruébalo sin puntos ni guion primero (ej: 76543210). 
    // Si falla, prueba con guion (76543210-K).
    client: 'Cristian Guillermo Faure Leiva', 

    // 2. EL ID QUE CAPTURASTE
    // Si este falla, cámbialo por "001", "1" o el mismo RUT de arriba.
    company: '20220623154649705533', 

    // 3. TUS DATOS DE ACCESO
    user: 'oz@microchip.cl', 
    password: '@Emmet53279!', 

    // 4. ¿QUÉ PRODUCTO QUIERES BUSCAR? (Pon un código real de tu inventario)
    productoPrueba: 'g375', 

    apiUrl: 'https://api.defontana.com/api'
};

// ==========================================
// 🚀 INICIO DEL PROGRAMA
// ==========================================

async function ejecutarRobot() {
    console.log("🤖 INICIANDO ROBOT DEFONTANA (Modo API)...");
    console.log("------------------------------------------------");

    try {
        // PASO 1: AUTENTICACIÓN
        console.log("🔐 Intentando iniciar sesión...");
        console.log(`   User: ${CONFIG.user}`);
        console.log(`   Company ID: ${CONFIG.company}`);
        
        const responseAuth = await axios.get(`${CONFIG.apiUrl}/Auth`, {
            params: {
                client: CONFIG.client,
                company: CONFIG.company,
                user: CONFIG.user,
                password: CONFIG.password
            }
        });

        // La API suele devolver el token directamente como un string o dentro de un objeto
        // Ajustamos según lo que llegue
        const token = responseAuth.data; 
        
        console.log("✅ ¡LOGIN EXITOSO!");
        console.log("🔑 Token recibido (primeros 20 caracteres):", token.toString().substring(0, 20) + "...");
        console.log("------------------------------------------------");

        // PASO 2: CONSULTAR STOCK
        console.log(`🔎 Buscando información del producto: "${CONFIG.productoPrueba}"...`);

        const responseStock = await axios.get(`${CONFIG.apiUrl}/Inventory/GetBatchesInfo`, {
            params: {
                productID: CONFIG.productoPrueba
            },
            headers: {
                'Authorization': `Bearer ${token}` 
            }
        });

        console.log("📦 RESPUESTA DEL SERVIDOR:");
        // Mostramos el JSON bonito y ordenado
        console.log(JSON.stringify(responseStock.data, null, 2));

    } catch (error) {
        console.log("\n❌ ERROR DETECTADO:");
        if (error.response) {
            // El servidor respondió con un código de error (ej: 401, 404, 500)
            console.log(`   Status Code: ${error.response.status}`);
            console.log(`   Mensaje Servidor:`, error.response.data);
            
            if (error.response.status === 401) {
                console.log("\n💡 PISTA: Error 401 significa 'No Autorizado'.");
                console.log("   - Verifica que el RUT (client) esté bien escrito.");
                console.log("   - Si usaste el ID largo en 'company' y falló, prueba cambiarlo por '001' o '1'.");
            }
        } else {
            // Error de conexión o código
            console.log(`   Mensaje: ${error.message}`);
        }
    }
}

// Ejecutar
ejecutarRobot();
