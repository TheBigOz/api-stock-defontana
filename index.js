const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    // Limpiamos el SKU (quitamos espacios extra y lo ponemos en mayúsculas por si acaso)
    const skuLimpio = skuBuscado.trim().toUpperCase();

    console.log(`--- Iniciando búsqueda para: ${skuLimpio} ---`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true, // TRUE para producción
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--window-size=1920,1080'
            ]
        });

        // 1. LOGIN EN LA PÁGINA PRINCIPAL
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'networkidle2' });

        // Login
        await page.waitForSelector('input[formcontrolname="email"]');
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); // <--- REVISA TUS CREDENCIALES
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); // <--- REVISA TUS CREDENCIALES
        await page.click('button.df-primario');
        
        console.log('Login enviado...');
        
        // Esperamos a que cargue el dashboard inicial
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        // 2. SALTAR A "ERP DIGITAL" (NUEVA PESTAÑA)
        console.log('Buscando acceso a ERP Digital...');
        
        // Usamos XPath para encontrar el h3 que dice "ERP Digital"
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        // Preparamos la captura de la nueva pestaña
        const newTargetPromise = browser.waitForTarget(target => target.opener() === page.target());
        
        // Hacemos click
        await erpButton.click();
        
        // Esperamos que se abra la nueva pestaña
        const newTarget = await newTargetPromise;
        const erpPage = await newTarget.page();
        
        // Ahora trabajamos sobre erpPage (la nueva pestaña)
        await erpPage.setViewport({ width: 1920, height: 1080 });
        await erpPage.waitForNavigation({ waitUntil: 'networkidle2' });
        
        console.log('Dentro del ERP. Navegando al inventario...');

        // 3. NAVEGACIÓN POR EL MENÚ (Inventario -> Artículos)
        // Nota: A veces es mejor ir directo a la URL si la supiéramos, pero seguiremos tus pasos.
        
        // Clic en "Inventario" (buscando por texto)
        const menuInventarioXpath = "//span[contains(@class, 'menu-title') and contains(text(), 'Inventario')]";
        await erpPage.waitForXPath(menuInventarioXpath);
        const [btnInventario] = await erpPage.$x(menuInventarioXpath);
        await btnInventario.click();
        
        // Pequeña espera para la animación del menú
        await new Promise(r => setTimeout(r, 500));

        // Clic en "Artículos"
        const menuArticulosXpath = "//span[contains(@class, 'menu-title') and contains(text(), 'Artículos')]";
        await erpPage.waitForXPath(menuArticulosXpath);
        const [btnArticulos] = await erpPage.$x(menuArticulosXpath);
        await btnArticulos.click();

        console.log('Cargando módulo de artículos...');

        // 4. BÚSQUEDA DEL PRODUCTO
        // Esperamos el input de búsqueda que identificaste
        const searchInputSelector = 'input[formcontrolname="searchInputText"]';
        await erpPage.waitForSelector(searchInputSelector);
        
        // Escribimos el SKU
        await erpPage.type(searchInputSelector, skuLimpio);
        await erpPage.keyboard.press('Enter');

        console.log(`Buscando SKU: ${skuLimpio}...`);

        // Esperamos un momento a que la tabla reaccione (Defontana puede ser lento)
        // Esperamos a que aparezca AL MENOS una celda de código o que pase un tiempo prudente
        try {
            await erpPage.waitForSelector('.mat-column-id', { timeout: 5000 });
        } catch (e) {
            console.log('No aparecieron resultados rápido, asumiendo tabla vacía o carga lenta.');
        }

        // 5. EXTRACCIÓN DE DATOS (Scraping)
        const resultado = await erpPage.evaluate((sku) => {
            // Buscamos todas las filas
            const filas = document.querySelectorAll('tr.mat-row');
            
            // Si no hay filas, es que no hay stock (según tu lógica de "Con Stock" activado)
            if (filas.length === 0) {
                return null; // Retornamos null para indicar "No encontrado / Agotado"
            }

            // Recorremos las filas para encontrar la coincidencia exacta del SKU
            // Esto es importante porque si buscas "G3" te pueden salir "G30", "G31", etc.
            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                if (textoCodigo === sku) {
                    // ¡ENCONTRADO! Extraemos los datos
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        codigo: textoCodigo,
                        descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                        stock: celdaStock ? celdaStock.innerText.trim() : '0',
                        precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                    };
                }
            }
            
            return null; // Si hay filas pero ninguna coincide exactamente
        }, skuLimpio);

        // 6. RESPUESTA AL CLIENTE
        if (resultado) {
            res.json({
                status: 'ok',
                mensaje: 'Producto encontrado',
                data: resultado
            });
        } else {
            res.json({
                status: 'ok', // Status OK porque el robot funcionó, pero el producto no está
                mensaje: 'Agotado o No encontrado',
                data: {
                    codigo: skuLimpio,
                    stock: '0 (o no existe)',
                    precio: '-'
                }
            });
        }

    } catch (error) {
        console.error('Error fatal:', error);
        // Tomamos foto del error si es posible para depurar luego
        res.status(500).json({ error: 'Error en el proceso', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor listo en puerto ${port}`);
});

